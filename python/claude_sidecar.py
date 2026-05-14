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


@dataclass
class PendingPermission:
    future: asyncio.Future


class ClaudeSidecar:
    def __init__(self) -> None:
        self.permission_futures: Dict[str, PendingPermission] = {}
        self.active_clients: Dict[str, Any] = {}
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

        kwargs: Dict[str, Any] = {
            "cwd": message.get("cwd") or os.getcwd(),
            "include_partial_messages": True,
            "permission_mode": "default",
            "allowed_tools": message.get("allowed_tools") or ["Read", "Glob", "Grep"],
            "can_use_tool": can_use_tool,
        }
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
                "allowed_tools": kwargs["allowed_tools"],
                "can_use_tool": can_use_tool,
            }
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
            options = ClaudeAgentOptions(**safe)

        client = ClaudeSDKClient(options=options)
        self.active_clients[thread_id] = client
        last_session_id = message.get("resume")

        try:
            await client.connect()
            await client.query(message.get("prompt") or "")
            async for sdk_message in client.receive_response():
                last_session_id = self.emit_sdk_message(thread_id, turn_id, sdk_message, last_session_id)
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
            emit({"type": "error", "thread_id": thread_id, "turn_id": turn_id, "message": str(exc)})
            traceback.print_exc(file=sys.stderr)
        finally:
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
        if result and name.lower().startswith("result"):
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
        elif event_type == "content_block_start":
            self.emit_content_block(thread_id, turn_id, obj_get(event, "content_block", {}))

    def emit_content_block(self, thread_id: str, turn_id: str, block: Any) -> None:
        block_type = obj_get(block, "type", "")
        if block_type == "text":
            emit({"type": "text_delta", "thread_id": thread_id, "turn_id": turn_id, "delta": obj_get(block, "text", "")})
        elif block_type == "thinking":
            emit({"type": "reasoning_delta", "thread_id": thread_id, "turn_id": turn_id, "delta": obj_get(block, "thinking", "")})
        elif block_type == "tool_use":
            emit({
                "type": "tool_use",
                "thread_id": thread_id,
                "turn_id": turn_id,
                "tool_use_id": obj_get(block, "id", ""),
                "tool_name": obj_get(block, "name", ""),
                "input": obj_get(block, "input", {}) or {},
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
