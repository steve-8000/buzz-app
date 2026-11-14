use std::path::{Path, PathBuf};

#[path = "../build_env.rs"]
mod build_env;

#[path = "src/access/schema.rs"]
#[allow(dead_code)]
mod repository_access;

#[path = "../../src-tauri/src/federated_identity/config.rs"]
#[allow(dead_code)]
mod federated_identity_config;

const BUILDERLAB_URL_KEY: &str = "BUZZ_BUILDERLAB_URL";
const BUILDERLAB_APPS_DOMAIN_KEY: &str = "BUZZ_BUILDERLAB_APPS_DOMAIN";
const BUILDERLAB_API_BASE_PATH_KEY: &str = "BUZZ_BUILDERLAB_API_BASE_PATH";
const BUILDERLAB_APPS_CONTROL_PLANE_KEY: &str = "BUZZ_BUILDERLAB_APPS_CONTROL_PLANE";
const REPOSITORY_ACCESS_KEY: &str = "BUZZ_BUILD_REPOSITORY_ACCESS";

/// Default repository access rules, in `repository-access.json`'s schema. Every rule
/// must be usable, so a typo fails the build instead of dropping a rule. Cargo reads
/// `rustc-env` one line at a time, so the value is emitted as compact JSON.
fn repository_access(raw: Option<String>) -> Result<String, String> {
    let Some(raw) = raw.filter(|raw| !raw.is_empty()) else {
        return Ok(String::new());
    };
    let file = repository_access::parse(&raw)?;
    match file.problems.first() {
        Some(problem) => Err(problem.clone()),
        None if file.rules.is_empty() => Err("rules must not be empty".into()),
        None => Ok(serde_json::from_str::<serde_json::Value>(&raw)
            .map_err(|error| error.to_string())?
            .to_string()),
    }
}

/// The Apps control plane for the build's own Builderlab origin, overriding the public
/// table in `apps_control_plane`.
fn builderlab_apps_control_plane(
    local: &Path,
    origin: &str,
    process: Option<String>,
) -> Result<String, &'static str> {
    let values = build_env::load(local, &[BUILDERLAB_APPS_CONTROL_PLANE_KEY], |_| {
        process.clone()
    })?;
    let Some(raw) = values
        .get(BUILDERLAB_APPS_CONTROL_PLANE_KEY)
        .filter(|raw| !raw.is_empty())
        .cloned()
    else {
        return Ok(String::new());
    };
    let url = url::Url::parse(&raw).map_err(|_| "Invalid Builderlab Apps control plane")?;
    if origin.is_empty() || url.scheme() != "https" || url.origin().ascii_serialization() != raw {
        return Err("Builderlab Apps control plane must be an HTTPS origin with a login origin");
    }
    Ok(raw)
}
const MANAGED_PLUGINS_URL_KEY: &str = "BUZZ_BUILD_MANAGED_PLUGINS_URL";
const MANAGED_PLUGINS_URL_MAX_CHARS: usize = 2048;

fn packaged_managed_plugins_url(
    local: &Path,
    process: Option<String>,
) -> Result<String, &'static str> {
    let values = build_env::load(local, &[MANAGED_PLUGINS_URL_KEY], |_| process.clone())?;
    let raw = values
        .get(MANAGED_PLUGINS_URL_KEY)
        .map(|value| value.trim())
        .unwrap_or("");
    if raw.is_empty() {
        return Ok(String::new());
    }
    let url = url::Url::parse(raw).map_err(|_| "BUZZ_BUILD_MANAGED_PLUGINS_URL is not a URL")?;
    if url.scheme() != "https"
        || url.host_str().is_none_or(str::is_empty)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.as_str().len() > MANAGED_PLUGINS_URL_MAX_CHARS
    {
        return Err("BUZZ_BUILD_MANAGED_PLUGINS_URL must be an https URL without credentials or a fragment, at most 2048 characters");
    }
    Ok(url.into())
}

fn builderlab_apps_domain(
    local: &Path,
    origin: &str,
    process: Option<String>,
) -> Result<String, &'static str> {
    let values = build_env::load(local, &[BUILDERLAB_APPS_DOMAIN_KEY], |_| process.clone())?;
    let domain = values
        .get(BUILDERLAB_APPS_DOMAIN_KEY)
        .map(String::as_str)
        .unwrap_or(if origin == "https://app.builderlab.xyz" {
            "apps.builderlab.xyz"
        } else {
            ""
        });
    if domain.is_empty() {
        return Ok(String::new());
    }
    let url = url::Url::parse(&format!("https://{domain}"))
        .map_err(|_| "Invalid Builderlab Apps build domain")?;
    if origin.is_empty()
        || !domain.contains('.')
        || domain.len() > 253
        || url.domain() != Some(domain)
        || domain.split('.').any(|label| {
            label.is_empty()
                || label.len() > 63
                || label.starts_with('-')
                || label.ends_with('-')
                || !label
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
    {
        return Err("Builderlab Apps build domain must be an exact DNS domain with a login origin");
    }
    Ok(domain.into())
}

const FI: &str = "BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG";

fn federated_identity(
    env: impl Fn(&str) -> Option<String>,
) -> Option<federated_identity_config::Config> {
    let added = env(FI);
    if added.as_deref().is_some_and(|raw| !raw.is_empty())
        && env(BUILDERLAB_URL_KEY).is_some_and(|url| !url.is_empty())
    {
        panic!("BUZZ_BUILDERLAB_URL must be removed when FI is configured");
    }
    federated_identity_config::compiled(added.as_deref())
        .expect("Invalid FI deployment descriptor")
        .into_iter()
        .next()
}

#[cfg_attr(test, allow(dead_code))]
fn main() {
    let root = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../..");
    let local = root.join(".env.local");
    println!("cargo:rerun-if-changed={}", local.display());
    println!("cargo:rerun-if-env-changed={BUILDERLAB_URL_KEY}");
    println!("cargo:rerun-if-env-changed={BUILDERLAB_APPS_DOMAIN_KEY}");
    println!("cargo:rerun-if-env-changed={BUILDERLAB_APPS_CONTROL_PLANE_KEY}");
    println!("cargo:rerun-if-env-changed={REPOSITORY_ACCESS_KEY}");
    println!(
        "cargo:rerun-if-changed={}",
        root.join("crates/plugin-manager/src/access/schema.rs")
            .display()
    );
    println!("cargo:rerun-if-env-changed={MANAGED_PLUGINS_URL_KEY}");
    println!(
        "cargo:rerun-if-changed={}",
        root.join("crates/build_env.rs").display()
    );
    let process = |key: &str| match std::env::var(key) {
        Ok(value) => Some(value),
        Err(std::env::VarError::NotPresent) => None,
        Err(std::env::VarError::NotUnicode(_)) => panic!("Native build inputs must be UTF-8"),
    };
    println!("cargo:rerun-if-env-changed={FI}");
    let fi = federated_identity(process);
    println!(
        "cargo:rustc-env={FI}={}",
        fi.as_ref()
            .map(|config| serde_json::to_string(config).expect("public FI descriptor"))
            .unwrap_or_default()
    );
    // An FI build signs in to Builderlab through its NIP-FI identity origin.
    let (origin, api_base_path) = match &fi {
        Some(config) => (config.identity_origin.clone(), config.api_base_path.clone()),
        None => (String::new(), String::new()),
    };
    let apps_domain = if origin.is_empty() {
        String::new()
    } else {
        builderlab_apps_domain(&local, &origin, process(BUILDERLAB_APPS_DOMAIN_KEY))
            .expect("Invalid Builderlab Apps build configuration")
    };
    println!("cargo:rustc-env=BUZZ_BUILDERLAB_ORIGIN={origin}");
    println!("cargo:rustc-env={BUILDERLAB_API_BASE_PATH_KEY}={api_base_path}");
    println!("cargo:rustc-env=BUZZ_BUILDERLAB_APPS_DOMAIN={apps_domain}");
    let control_plane = if origin.is_empty() {
        String::new()
    } else {
        builderlab_apps_control_plane(&local, &origin, process(BUILDERLAB_APPS_CONTROL_PLANE_KEY))
            .expect("Invalid Builderlab Apps control plane build configuration")
    };
    println!("cargo:rustc-env={BUILDERLAB_APPS_CONTROL_PLANE_KEY}={control_plane}");
    let access = repository_access(process(REPOSITORY_ACCESS_KEY))
        .unwrap_or_else(|reason| panic!("Invalid {REPOSITORY_ACCESS_KEY}: {reason}"));
    println!("cargo:rustc-env={REPOSITORY_ACCESS_KEY}={access}");
    let managed = packaged_managed_plugins_url(&local, process(MANAGED_PLUGINS_URL_KEY))
        .expect("Invalid packaged managed plugin policy URL");
    println!("cargo:rustc-env={MANAGED_PLUGINS_URL_KEY}={managed}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_explicit_sign_in_servers_are_compiled() {
        assert!(federated_identity(|_| None).is_none());
        let descriptor = r#"{"version":1,"id":"self-hosted","identityOrigin":"https://identity.example","communityHosts":["relay.example"],"adapterBase":"https://identity.example/api","apiBasePath":"/api/"}"#;
        let selected = federated_identity(|key| (key == FI).then(|| descriptor.to_owned()));
        assert_eq!(selected.unwrap().id, "self-hosted");
    }

    #[test]
    fn packaged_managed_plugins_url_accepts_only_plain_https() {
        let directory = tempfile::tempdir().unwrap();
        let local = directory.path().join(".env.local");
        assert_eq!(packaged_managed_plugins_url(&local, None).unwrap(), "");
        assert_eq!(
            packaged_managed_plugins_url(&local, Some(" \n".into())).unwrap(),
            ""
        );
        assert_eq!(
            packaged_managed_plugins_url(
                &local,
                Some(" https://plugins.example/policy.json?v=1 ".into())
            )
            .unwrap(),
            "https://plugins.example/policy.json?v=1"
        );
        for raw in [
            "plugins.example/policy.json",
            "http://plugins.example/policy.json",
            "file:///etc/policy.json",
            "https://user:secret@plugins.example/policy.json",
            "https://plugins.example/policy.json#latest",
        ] {
            assert!(
                packaged_managed_plugins_url(&local, Some(raw.into())).is_err(),
                "{raw}"
            );
        }
        assert!(packaged_managed_plugins_url(
            &local,
            Some(format!("https://plugins.example/{}", "a".repeat(2048)))
        )
        .is_err());
        std::fs::write(
            &local,
            "BUZZ_BUILD_MANAGED_PLUGINS_URL=https://plugins.example/policy.json\n",
        )
        .unwrap();
        assert_eq!(
            packaged_managed_plugins_url(&local, None).unwrap(),
            "https://plugins.example/policy.json"
        );
    }

    #[test]
    fn exact_apps_domain_uses_trusted_build_input_and_public_default() {
        let directory = tempfile::tempdir().unwrap();
        let local = directory.path().join(".env.local");
        assert_eq!(
            builderlab_apps_domain(&local, "https://app.builderlab.xyz", None).unwrap(),
            "apps.builderlab.xyz"
        );
        assert_eq!(
            builderlab_apps_domain(&local, "https://login.example", None).unwrap(),
            ""
        );
        std::fs::write(&local, "BUZZ_BUILDERLAB_APPS_DOMAIN=apps.example\n").unwrap();
        assert_eq!(
            builderlab_apps_domain(&local, "https://login.example", None).unwrap(),
            "apps.example"
        );
        assert_eq!(
            builderlab_apps_domain(
                &local,
                "https://login.example",
                Some("apps.other.example".into())
            )
            .unwrap(),
            "apps.other.example"
        );
        assert_eq!(
            builderlab_apps_domain(&local, "https://app.builderlab.xyz", Some(String::new()))
                .unwrap(),
            ""
        );
        for domain in [
            "com",
            "https://apps.example",
            "apps.example:443",
            "apps.example/path",
            "apps.example?query",
            "apps.example#part",
            "user@apps.example",
            "127.0.0.1",
            ".apps.example",
        ] {
            assert!(
                builderlab_apps_domain(&local, "https://login.example", Some(domain.into()))
                    .is_err()
            );
        }
        assert!(builderlab_apps_domain(&local, "", Some("apps.example".into())).is_err());
    }

    #[test]
    fn repository_access_build_input_must_be_fully_usable() {
        assert_eq!(repository_access(None).unwrap(), "");
        assert_eq!(repository_access(Some(String::new())).unwrap(), "");
        let rule = r#"{"version": 1, "rules": [{"host": "git.example.com", "pathPrefix": "/team/", "sshUser": "git"}]}"#;
        let compact = r#"{"rules":[{"host":"git.example.com","pathPrefix":"/team/","sshUser":"git"}],"version":1}"#;
        assert_eq!(repository_access(Some(rule.into())).unwrap(), compact);
        // Pretty-printed input reaches `env!` whole: one line, the same rules.
        let pretty = "{\n  \"version\": 1,\n  \"rules\": [\n    {\"host\": \"git.example.com\", \"pathPrefix\": \"/team/\", \"sshUser\": \"git\"}\n  ]\n}\n";
        let emitted = repository_access(Some(pretty.into())).unwrap();
        assert_eq!(emitted, compact);
        assert!(!emitted.contains(['\n', '\r']));
        let parsed = repository_access::parse(&emitted).unwrap();
        assert_eq!(parsed.rules.len(), 1);
        assert!(parsed.problems.is_empty());
        for raw in [
            "{",
            r#"{"version": 2}"#,
            r#"{"version": 1, "rules": []}"#,
            r#"{"version": 1, "rules": [{"host": "git.example.com", "pathPrefix": "/team/"}]}"#,
        ] {
            assert!(repository_access(Some(raw.into())).is_err(), "{raw}");
        }
    }

    #[test]
    fn apps_control_plane_build_input_is_an_https_origin() {
        let directory = tempfile::tempdir().unwrap();
        let local = directory.path().join(".env.local");
        let login = "https://login.example";
        let plane =
            |raw: &str, origin| builderlab_apps_control_plane(&local, origin, Some(raw.into()));
        assert_eq!(
            builderlab_apps_control_plane(&local, login, None).unwrap(),
            ""
        );
        assert_eq!(
            plane("https://ctrl.example", login).unwrap(),
            "https://ctrl.example"
        );
        // Like the frontend: .env.local applies, process overrides it, and Vite
        // mode files are never read.
        std::fs::write(
            directory.path().join(".env.production"),
            "BUZZ_BUILDERLAB_APPS_CONTROL_PLANE=https://mode.example\n",
        )
        .unwrap();
        assert_eq!(
            builderlab_apps_control_plane(&local, login, None).unwrap(),
            ""
        );
        std::fs::write(
            &local,
            "BUZZ_BUILDERLAB_APPS_CONTROL_PLANE=https://local.example\n",
        )
        .unwrap();
        assert_eq!(
            builderlab_apps_control_plane(&local, login, None).unwrap(),
            "https://local.example"
        );
        assert_eq!(
            plane("https://ctrl.example", login).unwrap(),
            "https://ctrl.example"
        );
        for raw in [
            "http://ctrl.example",
            "https://ctrl.example/",
            "https://ctrl.example/path",
            "ctrl.example",
        ] {
            assert!(plane(raw, login).is_err(), "{raw}");
        }
        assert!(plane("https://ctrl.example", "").is_err());
    }
}
