use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const JSONRPC_VERSION: &str = "2.0";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageKind {
    Request,
    Notification,
    Response,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JsonRpcEnvelope {
    #[serde(flatten)]
    fields: Map<String, Value>,
}

impl JsonRpcEnvelope {
    pub fn jsonrpc(&self) -> Option<&str> {
        self.fields.get("jsonrpc").and_then(Value::as_str)
    }

    pub fn method(&self) -> Option<&str> {
        self.fields.get("method").and_then(Value::as_str)
    }

    pub fn id(&self) -> Option<&Value> {
        self.fields.get("id")
    }

    pub fn kind(&self) -> Option<MessageKind> {
        match (
            self.method().is_some(),
            self.id().is_some(),
            self.fields.contains_key("result") || self.fields.contains_key("error"),
        ) {
            (true, true, _) => Some(MessageKind::Request),
            (true, false, _) => Some(MessageKind::Notification),
            (false, true, true) => Some(MessageKind::Response),
            (false, false, _) | (false, true, false) => None,
        }
    }
}

pub fn parse_envelope(input: &str) -> Result<JsonRpcEnvelope, serde_json::Error> {
    serde_json::from_str(input)
}

#[cfg(test)]
mod tests {
    use super::{parse_envelope, JsonRpcEnvelope, MessageKind, JSONRPC_VERSION};
    use serde_json::Value;

    struct Fixture {
        name: &'static str,
        json: &'static str,
        kind: MessageKind,
        method: Option<&'static str>,
    }

    const FIXTURES: &[Fixture] = &[
        Fixture {
            name: "initialize.request.json",
            json: include_str!("../fixtures/initialize.request.json"),
            kind: MessageKind::Request,
            method: Some("initialize"),
        },
        Fixture {
            name: "thread-start.request.json",
            json: include_str!("../fixtures/thread-start.request.json"),
            kind: MessageKind::Request,
            method: Some("thread/start"),
        },
        Fixture {
            name: "config-read.request.json",
            json: include_str!("../fixtures/config-read.request.json"),
            kind: MessageKind::Request,
            method: Some("config/read"),
        },
        Fixture {
            name: "turn-started.notification.json",
            json: include_str!("../fixtures/turn-started.notification.json"),
            kind: MessageKind::Notification,
            method: Some("turn/started"),
        },
        Fixture {
            name: "turn-completed.notification.json",
            json: include_str!("../fixtures/turn-completed.notification.json"),
            kind: MessageKind::Notification,
            method: Some("turn/completed"),
        },
        Fixture {
            name: "mcp-server-status-list.response.json",
            json: include_str!("../fixtures/mcp-server-status-list.response.json"),
            kind: MessageKind::Response,
            method: None,
        },
        Fixture {
            name: "config-read.response.json",
            json: include_str!("../fixtures/config-read.response.json"),
            kind: MessageKind::Response,
            method: None,
        },
    ];

    #[test]
    fn fixture_envelopes_round_trip_without_losing_required_fields(
    ) -> Result<(), Box<dyn std::error::Error>> {
        for fixture in FIXTURES {
            let envelope = parse_envelope(fixture.json)?;
            assert_eq!(
                envelope.jsonrpc(),
                Some(JSONRPC_VERSION),
                "{}",
                fixture.name
            );
            assert_eq!(envelope.kind(), Some(fixture.kind), "{}", fixture.name);
            assert_eq!(envelope.method(), fixture.method, "{}", fixture.name);

            let original: Value = serde_json::from_str(fixture.json)?;
            let serialized: Value = serde_json::to_value(&envelope)?;
            assert_eq!(serialized, original, "{}", fixture.name);
        }
        Ok(())
    }

    #[test]
    fn response_fixture_preserves_mcp_status_payload() -> Result<(), Box<dyn std::error::Error>> {
        let envelope: JsonRpcEnvelope = parse_envelope(include_str!(
            "../fixtures/mcp-server-status-list.response.json"
        ))?;
        let serialized = serde_json::to_value(&envelope)?;
        let Some(data) = serialized
            .get("result")
            .and_then(|result| result.get("data"))
            .and_then(Value::as_array)
        else {
            return Err("missing result.data array".into());
        };
        let Some(entry) = data.first() else {
            return Err("missing MCP status entry".into());
        };

        assert_eq!(entry.get("name").and_then(Value::as_str), Some("github"));
        assert!(entry.get("tools").and_then(Value::as_object).is_some());
        assert!(entry.get("resources").and_then(Value::as_array).is_some());
        assert!(entry
            .get("resourceTemplates")
            .and_then(Value::as_array)
            .is_some());
        assert_eq!(
            entry.get("authStatus").and_then(Value::as_str),
            Some("unsupported")
        );
        assert!(entry.get("status").is_none());
        Ok(())
    }

    #[test]
    fn response_fixture_preserves_config_read_provider_loop_projection(
    ) -> Result<(), Box<dyn std::error::Error>> {
        const UNSUPPORTED_CREDENTIAL_SOURCES: &[&str] = &[
            "personal-session",
            "browser-cookie",
            "session-token",
            "personal-subscription",
            "credential-sharing",
            "credential-pooling",
            "subscription-pooling",
            "private-proxy",
            "provider-bypass",
            "oauth-session",
            "cli-session-export",
        ];

        let envelope: JsonRpcEnvelope =
            parse_envelope(include_str!("../fixtures/config-read.response.json"))?;
        let serialized = serde_json::to_value(&envelope)?;
        let Some(provider_loop_config) = serialized
            .get("result")
            .and_then(|result| result.get("config"))
            .and_then(|config| config.get("provider_loop_config"))
        else {
            return Err("missing result.config.provider_loop_config".into());
        };
        let Some(providers) = provider_loop_config
            .get("providers")
            .and_then(Value::as_array)
        else {
            return Err("missing provider_loop_config.providers array".into());
        };

        let provider_ids: Vec<_> = providers
            .iter()
            .filter_map(|provider| provider.get("id").and_then(Value::as_str))
            .collect();
        assert_eq!(provider_ids, ["claude-code", "codex"]);
        let Some(issues) = provider_loop_config.get("issues").and_then(Value::as_array) else {
            return Err("missing provider_loop_config.issues array".into());
        };
        assert!(issues.is_empty());

        let Some(claude_code) = providers
            .iter()
            .find(|provider| provider.get("id").and_then(Value::as_str) == Some("claude-code"))
        else {
            return Err("missing claude-code provider".into());
        };
        assert_eq!(
            claude_code.get("providerFamily").and_then(Value::as_str),
            Some("anthropic")
        );
        assert_eq!(
            claude_code.get("loopId").and_then(Value::as_str),
            Some("native-claude-code-sdk")
        );
        assert_eq!(
            claude_code.get("status").and_then(Value::as_str),
            Some("stable")
        );
        assert_eq!(
            claude_code.get("supportsSteer").and_then(Value::as_bool),
            Some(true)
        );

        let Some(allowed_sources) = claude_code
            .get("allowedCredentialSources")
            .and_then(Value::as_array)
        else {
            return Err("missing claude-code allowedCredentialSources".into());
        };
        assert!(allowed_sources
            .iter()
            .any(|source| source.as_str() == Some("user-api-key")));
        for unsupported in UNSUPPORTED_CREDENTIAL_SOURCES {
            assert!(
                allowed_sources
                    .iter()
                    .all(|source| source.as_str() != Some(unsupported)),
                "unsupported credential source projected as allowed: {unsupported}"
            );
        }
        Ok(())
    }
}
