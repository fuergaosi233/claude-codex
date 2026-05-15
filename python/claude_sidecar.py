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
        return concise_string_value(raw_text, "value")
    if schema_type == "array":
        item_schema = schema.get("items") if isinstance(schema.get("items"), dict) else {"type": "string"}
        values = [line.strip().lstrip("-*0123456789.、) ") for line in raw_text.splitlines() if line.strip()]
        if not values:
            values = [raw_text.strip()] if raw_text.strip() else []
        return [coerce_structured_output(item_schema, value) for value in values[:10]]
    if schema_type != "object":
        return None
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
        result[name] = coerce_structured_output(prop, raw_text)
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


def summarize_runtime_event(event_type: str, event: Any) -> tuple[str, str]:
    """Turn a Claude runtime side-event into a (level, message) pair.

    Pulls the meaningful fields out of rate-limit / hook / subagent / compaction
    events instead of dumping truncated raw JSON, so the Codex App shows a clean,
    actionable line.
    """
    if not isinstance(event, dict):
        return "info", f"{event_type}: {str(event)[:300]}"

    if event_type == "rate_limit_event":
        retry = event.get("retry_after") or event.get("retryAfter") or event.get("reset_at")
        scope = event.get("scope") or event.get("limit_type") or event.get("type")
        detail = event.get("message") or event.get("error")
        parts = ["Claude rate limit reached"]
        if scope:
            parts.append(f"scope={scope}")
        if retry:
            parts.append(f"retry_after={retry}")
        if detail:
            parts.append(str(detail))
        return "warning", " · ".join(parts)

    if event_type in ("hook_event",):
        name = event.get("hook_name") or event.get("name") or "hook"
        status = event.get("status") or event.get("decision") or event.get("event")
        detail = event.get("message") or event.get("reason")
        msg = f"Claude hook '{name}'"
        if status:
            msg += f" {status}"
        if detail:
            msg += f": {detail}"
        return "info", msg

    if event_type in ("subagent_event", "subagent_stop"):
        name = event.get("subagent") or event.get("name") or event.get("agent") or "subagent"
        status = "stopped" if event_type == "subagent_stop" else (event.get("status") or event.get("event") or "update")
        detail = event.get("message") or event.get("result")
        msg = f"Claude subagent '{name}' {status}"
        if detail:
            msg += f": {str(detail)[:300]}"
        return "info", msg

    if event_type in ("precompact", "postcompact"):
        phase = "before" if event_type == "precompact" else "after"
        trigger = event.get("trigger") or event.get("reason")
        msg = f"Claude context compaction ({phase})"
        if trigger:
            msg += f": {trigger}"
        return "info", msg

    return "info", f"{event_type}: {json.dumps(event, ensure_ascii=False, default=str)[:600]}"


@dataclass
class PendingPermission:
    future: asyncio.Future


READ_ONLY_TOOLS = ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite", "Task"]


def derive_permission_mode(approval_policy: Any, sandbox_mode: Any) -> str:
    """Map Codex (approvalPolicy, sandbox) tier onto Claude SDK permission_mode.

    Honour CLAUDE_CODEX_PERMISSION_MODE as a hard override so operators can
    pin the runtime regardless of what the App requests.
    """
    override = os.environ.get("CLAUDE_CODEX_PERMISSION_MODE", "").strip()
    if override in ("default", "acceptEdits", "bypassPermissions", "plan"):
        return override
    ap = (approval_policy or "").strip() if isinstance(approval_policy, str) else ""
    sb = (sandbox_mode or "").strip() if isinstance(sandbox_mode, str) else ""
    if ap == "never":
        return "bypassPermissions"
    if ap == "on-failure":
        return "acceptEdits"
    if sb == "danger-full-access":
        return "bypassPermissions"
    return "default"


class ClaudeSidecar:
    def __init__(self) -> None:
        self.permission_futures: Dict[str, PendingPermission] = {}
        self.active_clients: Dict[str, Any] = {}
        self.structured_outputs_emitted: set[str] = set()
        self.structured_output_schemas: Dict[str, Any] = {}
        self.structured_text_buffers: Dict[str, list[str]] = {}
        # Tool-use ids of active Task (subagent) calls per thread. While a Task
        # is in flight we hide its inner text/tool_use/tool_result events so
        # Codex App renders one Agent item instead of a wall of leaked sub-tool
        # calls. Cleared in the query() finally clause for safety.
        self.active_subagent_ids: Dict[str, set] = {}
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
        # Reset any leaked subagent state from a previous turn on this thread.
        self.active_subagent_ids.pop(thread_id, None)
        output_format = message.get("output_format")
        if isinstance(output_format, dict) and output_format.get("type") == "json_schema":
            self.structured_output_schemas[f"{thread_id}:{turn_id}"] = output_format.get("schema")
            self.structured_text_buffers[f"{thread_id}:{turn_id}"] = []
        else:
            self.structured_output_schemas.pop(f"{thread_id}:{turn_id}", None)
            self.structured_text_buffers.pop(f"{thread_id}:{turn_id}", None)

        permission_mode = derive_permission_mode(
            message.get("approval_policy"), message.get("sandbox_mode")
        )
        kwargs: Dict[str, Any] = {
            "cwd": message.get("cwd") or os.getcwd(),
            "include_partial_messages": True,
            "permission_mode": permission_mode,
            "setting_sources": ["user", "project", "local"],
        }
        # Per-thread instruction surface from Codex App (project / developer /
        # personality). claude-agent-sdk 0.2.x lets us preserve Claude Code's
        # default system prompt and tack our addendum on via the preset
        # "append" field, so the user's settings actually take effect without
        # clobbering the runtime's built-in tools/behavior text.
        addendum = message.get("system_prompt_addendum")
        if isinstance(addendum, str) and addendum.strip():
            kwargs["system_prompt"] = {
                "type": "preset",
                "preset": "claude_code",
                "append": addendum.strip(),
            }
        # Only attach the can_use_tool callback when we actually want per-tool
        # approval. In bypass mode the SDK should run tools immediately and not
        # ping us for every Bash/Edit/Write — that round-trip is the whole
        # reason "Full access" used to keep showing "Awaiting approval".
        if permission_mode != "bypassPermissions":
            kwargs["can_use_tool"] = can_use_tool

        # When the App pinned read-only sandbox we must not let Claude use
        # write/exec tools, even if the caller's allowed_tools list said so.
        sandbox_mode = message.get("sandbox_mode")
        if isinstance(sandbox_mode, str) and sandbox_mode == "read-only":
            kwargs["allowed_tools"] = list(READ_ONLY_TOOLS)
        elif message.get("allowed_tools"):
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

        # Older SDKs may not accept every option. Drop unsupported options one
        # at a time (least essential first) instead of collapsing to a bare
        # core set, so streaming/session options survive whenever possible.
        droppable_in_priority = [
            "effort",
            "enable_file_checkpointing",
            "output_format",
            "add_dirs",
            "fork_session",
            "mcp_servers",
            "system_prompt",
            "setting_sources",
            "include_partial_messages",
            "allowed_tools",
            "resume",
        ]
        attempt = dict(kwargs)
        while True:
            try:
                options = ClaudeAgentOptions(**attempt)
                break
            except TypeError:
                dropped = next((k for k in droppable_in_priority if k in attempt), None)
                if dropped is None:
                    raise
                del attempt[dropped]
                emit({
                    "type": "notice",
                    "thread_id": thread_id,
                    "turn_id": turn_id,
                    "level": "info",
                    "message": f"claude-agent-sdk does not support option '{dropped}'; continuing without it.",
                })

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
                # The installed claude-agent-sdk is too old to parse Claude
                # Code's rate_limit_event frame. Content received before the
                # frame is still valid, so flush what we have and surface a
                # visible warning instead of silently reporting success.
                emit({
                    "type": "notice",
                    "thread_id": thread_id,
                    "turn_id": turn_id,
                    "level": "warning",
                    "message": (
                        "claude-agent-sdk could not parse a rate_limit_event from Claude Code; "
                        "the response above may be truncated. Upgrade claude-agent-sdk to resolve this."
                    ),
                })
                self.flush_structured_output(thread_id, turn_id)
                emit({
                    "type": "completed",
                    "thread_id": thread_id,
                    "turn_id": turn_id,
                    "success": True,
                    "result": "rate_limit_event (sdk parse gap)",
                    "claude_session_id": last_session_id,
                })
                return
            emit({"type": "error", "thread_id": thread_id, "turn_id": turn_id, "message": str(exc)})
            traceback.print_exc(file=sys.stderr)
        finally:
            self.structured_output_schemas.pop(f"{thread_id}:{turn_id}", None)
            self.structured_text_buffers.pop(f"{thread_id}:{turn_id}", None)
            self.active_subagent_ids.pop(thread_id, None)
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
        if name.lower().startswith("result"):
            usage = obj_get(message, "usage", None)
            if isinstance(usage, dict) and usage:
                emit({"type": "usage", "thread_id": thread_id, "turn_id": turn_id, "usage": usage})
        if result and name.lower().startswith("result"):
            self.flush_structured_output(thread_id, turn_id)
            emit({"type": "completed", "thread_id": thread_id, "turn_id": turn_id, "success": not bool(obj_get(message, "is_error", False)), "result": result, "claude_session_id": last_session_id})
        return last_session_id

    def emit_stream_event(self, thread_id: str, turn_id: str, event: Any) -> None:
        event_type = obj_get(event, "type", "")
        in_subagent = bool(self.active_subagent_ids.get(thread_id))
        if event_type == "content_block_delta":
            # While a Task subagent is in flight, all streaming text/thinking
            # belongs to the subagent; we hide it so Codex App keeps showing one
            # collapsed Agent item instead of bleeding partial sub-text into
            # the main thread.
            if in_subagent:
                return
            delta = obj_get(event, "delta", {})
            delta_type = obj_get(delta, "type", "")
            if delta_type == "text_delta":
                emit({"type": "text_delta", "thread_id": thread_id, "turn_id": turn_id, "delta": obj_get(delta, "text", "")})
            elif delta_type == "thinking_delta":
                thinking = obj_get(delta, "thinking", "")
                if thinking:
                    emit({"type": "reasoning_delta", "thread_id": thread_id, "turn_id": turn_id, "delta": thinking})
            # StructuredOutput streams as input_json_delta chunks and is emitted
            # once from the final ToolUseBlock carrying the parsed JSON input.
        elif event_type == "content_block_start":
            block = obj_get(event, "content_block", {})
            if obj_get(block, "name", "") != "StructuredOutput":
                self.emit_content_block(thread_id, turn_id, block)
        elif event_type in ("rate_limit_event", "hook_event", "subagent_event", "subagent_stop", "precompact", "postcompact"):
            level, message = summarize_runtime_event(event_type, event)
            emit({
                "type": "notice",
                "thread_id": thread_id,
                "turn_id": turn_id,
                "level": level,
                "message": message,
            })

    def emit_content_block(self, thread_id: str, turn_id: str, block: Any) -> None:
        # Claude Agent SDK 0.2.x ships its content blocks as bare @dataclass
        # instances (TextBlock / ThinkingBlock / ToolUseBlock / ToolResultBlock)
        # with NO `type` field, so a `block.type == "tool_result"` check alone
        # silently drops every tool_result and the matching item/started never
        # gets a item/completed pair. Detect by class_name as well.
        block_type = obj_get(block, "type", "")
        cname = class_name(block)
        active = self.active_subagent_ids.setdefault(thread_id, set())

        if block_type == "text" or cname == "TextBlock" or obj_get(block, "text", None) is not None:
            # Inside a Task subagent the assistant text belongs to the sub-run;
            # hide it from the main thread so Codex shows a single Agent item.
            if active:
                return
            text = obj_get(block, "text", "")
            key = f"{thread_id}:{turn_id}"
            if key in self.structured_output_schemas and key not in self.structured_outputs_emitted:
                self.structured_text_buffers.setdefault(key, []).append(str(text))
                return
            emit({"type": "text_delta", "thread_id": thread_id, "turn_id": turn_id, "delta": text})
        elif block_type == "thinking" or cname == "ThinkingBlock":
            if active:
                return
            thinking = obj_get(block, "thinking", "")
            if thinking:
                emit({"type": "reasoning_delta", "thread_id": thread_id, "turn_id": turn_id, "delta": thinking})
        elif block_type == "tool_use" or cname == "ToolUseBlock":
            tool_name = obj_get(block, "name", "")
            tool_input = obj_get(block, "input", {}) or {}
            block_id = str(obj_get(block, "id", ""))
            if tool_name == "StructuredOutput":
                self.emit_structured_output(thread_id, turn_id, tool_input)
                return
            if tool_name == "Task":
                # Open the subagent context. Codex App still sees this Task as
                # a single mcpToolCall item; the sub-events between here and
                # the matching tool_result are intentionally suppressed.
                if block_id:
                    active.add(block_id)
            elif active:
                # Nested tool_use issued by the running Task subagent — drop it
                # so it does not leak into the main thread as a parallel item.
                return
            emit({
                "type": "tool_use",
                "thread_id": thread_id,
                "turn_id": turn_id,
                "tool_use_id": block_id,
                "tool_name": tool_name,
                "input": tool_input,
            })
        elif block_type == "tool_result" or cname == "ToolResultBlock":
            tool_use_id = str(obj_get(block, "tool_use_id", ""))
            if tool_use_id and tool_use_id in active:
                # The Task subagent finished — close the context and let Codex
                # render the final result on the original Agent item.
                active.discard(tool_use_id)
            elif active:
                # Some other tool_result that was issued inside the subagent.
                # Hide it; Codex would otherwise complete a non-existent item.
                return
            emit({
                "type": "tool_result",
                "thread_id": thread_id,
                "turn_id": turn_id,
                "tool_use_id": tool_use_id,
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
