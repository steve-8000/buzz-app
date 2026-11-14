//! What the helper may be asked for. Everything here is pure, so it is tested
//! on every platform; the macOS adapter only runs requests this module accepts.

/// Bumped when the request format or the set of served items changes.
/// `just desktop me` installs one helper per protocol, so checkouts on
/// different protocols each keep a helper that understands them.
pub const PROTOCOL: u32 = 1;

/// Largest value read or written, in either direction.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const LIMIT: usize = 2 * 1024 * 1024;

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const ABSENT: i32 = 10;
pub const DENIED: i32 = 11;
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const CORRUPT: i32 = 12;
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const OCCUPIED: i32 = 13;
pub const UNAVAILABLE: i32 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operation {
    Read,
    Add,
    Replace,
    Delete,
}

impl Operation {
    fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "read" => Self::Read,
            "add" => Self::Add,
            "replace" => Self::Replace,
            "delete" => Self::Delete,
            _ => return None,
        })
    }
    /// Whether the app sends a value for this operation.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub fn takes_value(self) -> bool {
        matches!(self, Self::Add | Self::Replace)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct Request {
    /// Whether a Keychain dialog may be shown for an item not yet approved.
    pub authorize: bool,
    pub operation: Operation,
    pub service: String,
    pub account: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Version,
    Item(Request),
}

/// `--version`, or `[--authorize] --item <operation> <service> <account>`.
/// A request for an item outside [`allowed`] is refused here, before any
/// peer check or Keychain call.
pub fn parse(args: &[String]) -> Result<Command, i32> {
    match args {
        [flag] if flag == "--version" => return Ok(Command::Version),
        _ => {}
    }
    let (authorize, rest) = match args.split_first() {
        Some((flag, rest)) if flag == "--authorize" => (true, rest),
        _ => (false, args),
    };
    let [mode, operation, service, account] = rest else {
        return Err(UNAVAILABLE);
    };
    if mode != "--item" {
        return Err(UNAVAILABLE);
    }
    let operation = Operation::parse(operation).ok_or(UNAVAILABLE)?;
    if !allowed(operation, service, account) {
        return Err(DENIED);
    }
    Ok(Command::Item(Request {
        authorize,
        operation,
        service: service.clone(),
        account: account.clone(),
    }))
}

fn hex64(account: &str) -> bool {
    account.len() == 64
        && account
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Accounts the app derives itself: ASCII letters, digits and `.-_:`, bounded.
fn plain(account: &str, prefix: &str) -> bool {
    account.len() > prefix.len()
        && account.len() <= 256
        && account.starts_with(prefix)
        && account[prefix.len()..]
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".-_:".contains(&byte))
}

/// The exact debug-build items `just desktop me` reads and writes, and the
/// release human key, which it may only read.
pub fn allowed(operation: Operation, service: &str, account: &str) -> bool {
    use Operation::*;
    match service {
        // The release build's key, for `me`: read only, never copied or changed.
        "one.clab.gram.identity" | "one.clab.gram.identity-store" => {
            operation == Read && account == "human"
        }
        // The debug build's own key is create-only; paired-tool records beside it are mutable.
        "one.clab.gram.identity.debug" | "one.clab.gram.identity-store.debug" => {
            if account == "human" {
                operation != Replace
            } else {
                plain(account, "credential-pairings.v1.")
            }
        }
        "one.clab.gram.agents" | "one.clab.gram.agent-store" => {
            account == "agent-bundle-v1" || plain(account, "agent:")
        }
        "one.clab.gram.federated-session.debug" => hex64(account),
        "one.clab.gram.jev-key.debug" | "one.clab.gram.jev-key-store.debug" => {
            account == "typesafe"
        }
        "one.clab.gram.claude-api-key.debug" => account == "anthropic",
        "one.clab.gram.external-app-pairing.v1" => hex64(account),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(text: &str) -> Vec<String> {
        text.split(' ').map(String::from).collect()
    }

    #[test]
    fn parses_version_and_items() {
        assert_eq!(parse(&args("--version")), Ok(Command::Version));
        assert_eq!(
            parse(&args(
                "--authorize --item read one.clab.gram.identity human"
            )),
            Ok(Command::Item(Request {
                authorize: true,
                operation: Operation::Read,
                service: "one.clab.gram.identity".into(),
                account: "human".into(),
            }))
        );
        assert!(matches!(
            parse(&args(
                "--item add one.clab.gram.identity.debug human"
            )),
            Ok(Command::Item(Request {
                authorize: false,
                operation: Operation::Add,
                ..
            }))
        ));
    }

    #[test]
    fn rejects_malformed_requests() {
        for bad in [
            "",
            "--item",
            "--item read one.clab.gram.identity",
            "--item read one.clab.gram.identity human extra",
            "--agent-store read one.clab.gram.agents agent-bundle-v1",
            "--session-store read one.clab.gram.federated-session.debug x",
            "--item copy one.clab.gram.identity human",
            "--authorize --authorize --item read one.clab.gram.identity human",
            "--item read one.clab.gram.identity human --authorize",
        ] {
            assert_eq!(parse(&args(bad)), Err(UNAVAILABLE), "{bad}");
        }
    }

    #[test]
    fn serves_only_the_listed_items() {
        use Operation::*;
        let hex = "0123456789abcdef".repeat(4);
        for (operation, service, account) in [
            (Read, "one.clab.gram.identity", "human"),
            (Read, "one.clab.gram.identity-store", "human"),
            (Read, "one.clab.gram.identity.debug", "human"),
            (Add, "one.clab.gram.identity.debug", "human"),
            (Delete, "one.clab.gram.identity.debug", "human"),
            (Read, "one.clab.gram.identity-store.debug", "human"),
            (
                Replace,
                "one.clab.gram.identity.debug",
                "credential-pairings.v1.main-1",
            ),
            (Replace, "one.clab.gram.agents", "agent-bundle-v1"),
            (Read, "one.clab.gram.agent-store", "agent:abc-def"),
            (
                Replace,
                "one.clab.gram.federated-session.debug",
                hex.as_str(),
            ),
            (
                Delete,
                "one.clab.gram.federated-session.debug",
                hex.as_str(),
            ),
            (Replace, "one.clab.gram.jev-key.debug", "typesafe"),
            (Read, "one.clab.gram.jev-key-store.debug", "typesafe"),
            (
                Replace,
                "one.clab.gram.claude-api-key.debug",
                "anthropic",
            ),
            (
                Replace,
                "one.clab.gram.external-app-pairing.v1",
                hex.as_str(),
            ),
        ] {
            assert!(
                allowed(operation, service, account),
                "{operation:?} {service} {account}"
            );
        }
        let upper = "0123456789ABCDEF".repeat(4);
        for (operation, service, account) in [
            // The release key is never written, copied over or deleted.
            (Add, "one.clab.gram.identity", "human"),
            (Replace, "one.clab.gram.identity", "human"),
            (Delete, "one.clab.gram.identity", "human"),
            (Delete, "one.clab.gram.identity-store", "human"),
            (
                Read,
                "one.clab.gram.identity",
                "credential-pairings.v1.main",
            ),
            // The debug key is create-only.
            (Replace, "one.clab.gram.identity.debug", "human"),
            (Read, "one.clab.gram.identity.debug", "other"),
            (
                Read,
                "one.clab.gram.identity.debug",
                "credential-pairings.v1.",
            ),
            (
                Read,
                "one.clab.gram.identity.debug",
                "credential-pairings.v1.a/b",
            ),
            (Read, "one.clab.gram.agents", "secrets"),
            (Read, "one.clab.gram.agents", "agent:"),
            // Release-build sessions and keys belong to the release app.
            (
                Read,
                "one.clab.gram.federated-session",
                hex.as_str(),
            ),
            (
                Read,
                "one.clab.gram.federated-session.debug",
                upper.as_str(),
            ),
            (
                Read,
                "one.clab.gram.federated-session.debug",
                "human",
            ),
            (Read, "one.clab.gram.jev-key", "typesafe"),
            (Read, "one.clab.gram.claude-api-key", "anthropic"),
            (
                Read,
                "one.clab.gram.claude-api-key.debug",
                "openai",
            ),
            // Old Buzz and anything else.
            (Read, "buzz-desktop", "secrets"),
            (Read, "app.buzz.onedotzero", "identity"),
            (Read, "", ""),
        ] {
            assert!(
                !allowed(operation, service, account),
                "{operation:?} {service} {account}"
            );
        }
        assert_eq!(
            parse(&args("--item read buzz-desktop secrets")),
            Err(DENIED)
        );
    }
}
