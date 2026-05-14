#!/usr/bin/env python3
"""JSONL sidecar that runs Claude Agent SDK turns for the Node adapter."""

from __future__ import annotations

import asyncio
import json
import os
import sys
import traceback
from dataclasses import dataclass
from typing import Any, Dict


def emit(message: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def obj_get(obj: Any, name: str, default: Any = None) -> Any:
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


def class_name(obj: Any) -> str:
    return obj.__class__.__name__


def coerce_structured_output(schema: Any, raw_text: str) -> Any:
    if not isinstance(schema, dict):
        return raw_text
    schema_type = schema.get("type")
    if schema_type == "string":
        return raw_text
    if schema_type != "object":
        return raw_text
    properties = schema.get("properties")
    if not isinstance(properties, dict):
        return {}
    required = schema.get("required")
    if not isinstance(required, list) or not required:
        required = list(properties.keys())
    result: Dict[str, Any] = {}
    for name in required:
        prop = properties.get(name)
        if not isinstance(name, str) or not isinstance(prop, dict):
            continue
        prop_type = prop.get("type")
        if prop_type == "string":
            result[name] = concise_string_value(raw_text, name)
        elif prop_type == "number":
            result[name] = 0
        elif prop_type == "integer":
            result[name] = 0
        elif prop_type == "boolean":
            result[name] = False
        elif prop_type == "array":
            result[name] = []
        elif prop_type == "object":
            result[name] = {}
        else:
            result[name] = None
    return result


def concise_string_value(raw_text: str, field_name: str) -> str:
    text = raw_text.strip()
    if not text:
        return ""
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict) and isinstance(parsed.get(field_name), str):
            return parsed[field_name].strip()
        if isinstance(parsed, str):
            text = parsed.strip()
    except Exception:
        pass
    for marker in ("**", '"'):
        if marker in text:
            parts = text.split(marker)
            if len(parts) >= 3 and parts[1].strip():
                return trim_title(parts[1])
    for line in text.splitlines():
        candidate = line.strip().lstrip("-*0123456789.、) ")
        if not candidate:
            continue
        if candidate.endswith(":") or candidate.endswith("："):
            continue
        if "：" in candidate:
            candidate = candidate.split("：", 1)[-1].strip()
        elif ":" in candidate and len(candidate.split(":", 1)[0]) < 16:
            candidate = candidate.split(":", 1)[-1].strip()
        if candidate:
            return trim_title(candidate)
    return trim_title(text)


def trim_title(value: str) -> str:
    value = value.strip().strip("'\\\"“”‘’* ")
    return value[:80].strip()


@dataclass
class PendingPermission:
    future: asyncio.Future


class ClaudeSidecar:
    def __init__(self) -> None:
        self.permission_futures: Dict[str, PendingPermission] = {}
        self.active_clients: Dict[str, Any] = {}
        self.structured_outputs_emitted: set[str] = set()
        self.structured_output_schemas: Dict[str, Any] = {}
        self.structured_text_buffers: Dict[str, list[str]] = {}
        self.queue: asyncio.Queue[Dict[str, Any]] = asyncio.Queue()

    async def run(self) -> None:
        reader_task = asyncio.create_task(self.read_stdin())
        try:
            while True:
                message = await self.queue.get()
                msg_type = message.get("type")
                if msg_type == "query":
                    asyncio.create_task(self.query(message))
                elif msg_type == "steer":
                    await self.steer(message)
                elif msg_type == "interrupt":
                    await self.interrupt(str(message.get("thread_id", "")))
                elif msg_type == "permission_response":
                    self.resolve_permission(message)
        finally:
            reader_task.cancel()

    async def read_stdin(self) -> None:
        loop = asyncio.get_running_loop()
        while True:
            line = await loop.run_in_executor(None, sys.stdin.readline)
            if not line:
                os._exit(0)
            try:
                await self.queue.put(json.loads(line))
            except Exception as exc:
                emit({"type": "error", "message": f"bad sidecar input: {exc}"})

    async def query(self, message: Dict[str, Any]) -> None:
        thread_id = str(message["thread_id"])
        turn_id = str(message["turn_id"])
        try:
            from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient
        except Exception as exc:
            emit({
                "type": "error",
                "thread_id": thread_id,
                "turn_id": turn_id,
                "message": (
                    "claude_agent_sdk is not installed. Install it on the remote host "
                    "with `pip install claude-agent-sdk`, or set CLAUDE_CODEX_MOCK=1. "
                    f"Import error: {exc}"
                ),
            })
            return

        async def can_use_tool(tool_name: str, input_data: Dict[str, Any], options: Any = None) -> Any:
            request_id = f"{thread_id}:{turn_id}:{tool_name}:{id(input_data)}"
            fut: asyncio.Future = asyncio.get_running_loop().create_future()
            self.permission_futures[request_id] = PendingPermission(fut)
            emit({
                "type": "permission_request",
                "thread_id": thread_id,
                "turn_id": turn_id,
                "request_id": request_id,
                "tool_use_id": request_id,
                "tool_name": tool_name,
                "input": input_data,
            })
            response = await fut
            decision = response.get("decision")
            updated_input = response.get("updated_input") or input_data
            try:
                from claude_agent_sdk import PermissionResultAllow, PermissionResultDeny
                if decision in ("accept", "acceptForSession"):
                    return PermissionResultAllow(updated_input=updated_input)
                return PermissionResultDeny(message="User declined permission in Codex")
            except Exception:
                return {"behavior": "allow" if decision in ("accept", "acceptForSession") else "deny"}

        self.structured_outputs_emitted.discard(f"{thread_id}:{turn_id}")
        output_format = message.get("output_format")
        if isinstance(output_format, dict) and output_format.get("type") == "json_schema":
            self.structured_output_schemas[f"{thread_id}:{turn_id}"] = output_format.get("schema")
            self.structured_text_buffers[f"{thread_id}:{turn_id}"] = []
        else:
            self.structured_output_schemas.pop(f"{thread_id}:{turn_id}", None)
            self.structured_text_buffers.pop(f"{thread_id}:{turn_id}", None)
        kwargs: Dict[str, Any] = {
            "cwd": message.get("cwd") or os.getcwd(),
            "include_partial_messages": True,
            "permission_mode": "default",
            "setting_sources": ["user", "project", "local"],
            "can_use_tool": can_use_tool,
        }
        if message.get("allowed_tools"):
            kwargs["allowed_tools"] = message["allowed_tools"]
        if message.get("model"):
            kwargs["model"] = message["model"]
        if os.environ.get("CLAUDE_CODEX_CLI"):
            kwargs["cli_path"] = os.environ["CLAUDE_CODEX_CLI"]
        if message.get("effort"):
            kwargs["effort"] = message["effort"]
        if message.get("resume"):
            kwargs["resume"] = message["resume"]
        if message.get("fork_session"):
            kwargs["fork_session"] = True
        if message.get("mcp_servers") is not None:
            kwargs["mcp_servers"] = message["mcp_servers"]
        if message.get("add_dirs"):
            kwargs["add_dirs"] = message["add_dirs"]
        if message.get("enable_file_checkpointing"):
            kwargs["enable_file_checkpointing"] = True
        if message.get("output_format") is not None:
            kwargs["output_format"] = message["output_format"]

        try:
            options = ClaudeAgentOptions(**kwargs)
        except TypeError:
            # Older SDKs may not accept every option. Keep the safe core.
            safe = {
                "cwd": kwargs["cwd"],
                "permission_mode": kwargs["permission_mode"],
                "setting_sources": kwargs["setting_sources"],
                "can_use_tool": can_use_tool,
            }
            if "allowed_tools" in kwargs:
                safe["allowed_tools"] = kwargs["allowed_tools"]
            if "model" in kwargs:
                safe["model"] = kwargs["model"]
            if "cli_path" in kwargs:
                safe["cli_path"] = kwargs["cli_path"]
            if "resume" in kwargs:
                safe["resume"] = kwargs["resume"]
            if "fork_session" in kwargs:
                safe["fork_session"] = kwargs["fork_session"]
            if "mcp_servers" in kwargs:
                safe["mcp_servers"] = kwargs["mcp_servers"]
            if "add_dirs" in kwargs:
                safe["add_dirs"] = kwargs["add_dirs"]
            if "output_format" in kwargs:
                safe["output_format"] = kwargs["output_format"]
            options = ClaudeAgentOptions(**safe)

        client = ClaudeSDKClient(options=options)
        self.active_clients[thread_id] = client
        last_session_id = message.get("resume")

        try:
            await client.connect()
            await client.query(message.get("prompt") or "")
            async for sdk_message in client.receive_response():
                last_session_id = self.emit_sdk_message(thread_id, turn_id, sdk_message, last_session_id)
            self.flush_structured_output(thread_id, turn_id)
            emit({
                "type": "completed",
                "thread_id": thread_id,
                "turn_id": turn_id,
                "success": True,
                "claude_session_id": last_session_id,
            })
        except asyncio.CancelledError:
            emit({"type": "completed", "thread_id": thread_id, "turn_id": turn_id, "success": False, "result": "interrupted"})
        except Exception as exc:
            if "Unknown message type: rate_limit_event" in str(exc):
                emit({
                    "type": "completed",
                    "thread_id": thread_id,
                    "turn_id": turn_id,
                    "success": True,
                    "claude_session_id": last_session_id,
                })
                return
            emit({"type": "error", "thread_id": thread_id, "turn_id": turn_id, "message": str(exc)})
            traceback.print_exc(file=sys.stderr)
        finally:
            self.structured_output_schemas.pop(f"{thread_id}:{turn_id}", None)
            self.structured_text_buffers.pop(f"{thread_id}:{turn_id}", None)
            self.active_clients.pop(thread_id, None)
            try:
                await client.disconnect()
            except Exception:
                pass

    def emit_sdk_message(self, thread_id: str, turn_id: str, message: Any, last_session_id: Any) -> Any:
        name = class_name(message)
        session_id = obj_get(message, "session_id", None) or obj_get(message, "sessionId", None)
        if session_id:
            last_session_id = session_id
            emit({"type": "session", "thread_id": thread_id, "turn_id": turn_id, "claude_session_id": session_id})

        if name == "StreamEvent" or obj_get(message, "type") == "stream_event":
            event = obj_get(message, "event", message)
            self.emit_stream_event(thread_id, turn_id, event)
            return last_session_id

        content = obj_get(obj_get(message, "message", message), "content", None)
        if isinstance(content, list):
            for block in content:
                self.emit_content_block(thread_id, turn_id, block)
        result = obj_get(message, "result", None)
        structured_output = obj_get(message, "structured_output", None)
        if structured_output is not None:
            self.emit_structured_output(thread_id, turn_id, structured_output)
        if result and name.lower().startswith("result"):
            self.flush_structured_output(thread_id, turn_id)
            emit({"type": "completed", "thread_id": thread_id, "turn_id": turn_id, "success": not bool(obj_get(message, "is_error", False)), "result": result, "claude_session_id": last_session_id})
        return last_session_id

    def emit_stream_event(self, thread_id: str, turn_id: str, event: Any) -> None:
        event_type = obj_get(event, "type", "")
        if event_type == "content_block_delta":
            delta = obj_get(event, "delta", {})
            delta_type = obj_get(delta, "type", "")
            if delta_type == "text_delta":
                emit({"type": "text_delta", "thread_id": thread_id, "turn_id": turn_id, "delta": obj_get(delta, "text", "")})
            elif delta_type in ("thinking_delta", "signature_delta"):
                emit({"type": "reasoning_delta", "thread_id": thread_id, "turn_id": turn_id, "delta": obj_get(delta, "thinking", "")})
            # StructuredOutput streams as input_json_delta chunks and is emitted
            # once from the final ToolUseBlock carrying the parsed JSON input.
        elif event_type == "content_block_start":
            block = obj_get(event, "content_block", {})
            if obj_get(block, "name", "") != "StructuredOutput":
                self.emit_content_block(thread_id, turn_id, block)

    def emit_content_block(self, thread_id: str, turn_id: str, block: Any) -> None:
        block_type = obj_get(block, "type", "")
        if block_type == "text" or class_name(block) == "TextBlock" or obj_get(block, "text", None) is not None:
            text = obj_get(block, "text", "")
            key = f"{thread_id}:{turn_id}"
            if key in self.structured_output_schemas and key not in self.structured_outputs_emitted:
                self.structured_text_buffers.setdefault(key, []).append(str(text))
                return
            emit({"type": "text_delta", "thread_id": thread_id, "turn_id": turn_id, "delta": text})
        elif block_type == "thinking":
            emit({"type": "reasoning_delta", "thread_id": thread_id, "turn_id": turn_id, "delta": obj_get(block, "thinking", "")})
        elif block_type == "tool_use" or class_name(block) == "ToolUseBlock":
            tool_name = obj_get(block, "name", "")
            tool_input = obj_get(block, "input", {}) or {}
            if tool_name == "StructuredOutput":
                self.emit_structured_output(thread_id, turn_id, tool_input)
                return
            emit({
                "type": "tool_use",
                "thread_id": thread_id,
                "turn_id": turn_id,
                "tool_use_id": obj_get(block, "id", ""),
                "tool_name": tool_name,
                "input": tool_input,
            })
        elif block_type == "tool_result":
            emit({
                "type": "tool_result",
                "thread_id": thread_id,
                "turn_id": turn_id,
                "tool_use_id": obj_get(block, "tool_use_id", ""),
                "content": obj_get(block, "content", ""),
                "is_error": bool(obj_get(block, "is_error", False)),
            })

    def emit_structured_output(self, thread_id: str, turn_id: str, value: Any) -> None:
        key = f"{thread_id}:{turn_id}"
        if key in self.structured_outputs_emitted:
            return
        self.structured_outputs_emitted.add(key)
        emit({"type": "text_delta", "thread_id": thread_id, "turn_id": turn_id, "delta": json.dumps(value, ensure_ascii=False, separators=(",", ":"))})

    def flush_structured_output(self, thread_id: str, turn_id: str) -> None:
        key = f"{thread_id}:{turn_id}"
        if key in self.structured_outputs_emitted or key not in self.structured_output_schemas:
            return
        raw_text = "".join(self.structured_text_buffers.get(key, [])).strip()
        self.emit_structured_output(thread_id, turn_id, coerce_structured_output(self.structured_output_schemas.get(key), raw_text))

    async def interrupt(self, thread_id: str) -> None:
        client = self.active_clients.get(thread_id)
        if not client:
            return
        try:
            await client.interrupt()
        except Exception as exc:
            emit({"type": "error", "thread_id": thread_id, "turn_id": "", "message": f"interrupt failed: {exc}"})

    async def steer(self, message: Dict[str, Any]) -> None:
        thread_id = str(message.get("thread_id", ""))
        client = self.active_clients.get(thread_id)
        if not client:
            emit({"type": "error", "thread_id": thread_id, "turn_id": "", "message": "steer failed: no active Claude client"})
            return
        try:
            await client.query(message.get("prompt") or "")
        except Exception as exc:
            emit({"type": "error", "thread_id": thread_id, "turn_id": "", "message": f"steer failed: {exc}"})

    def resolve_permission(self, message: Dict[str, Any]) -> None:
        request_id = str(message.get("request_id", ""))
        pending = self.permission_futures.pop(request_id, None)
        if pending and not pending.future.done():
            pending.future.set_result(message)


if __name__ == "__main__":
    asyncio.run(ClaudeSidecar().run())
