//! OS-backed persistence for the private desktop bearer credential.
//!
//! The caller supplies a stable, random installation namespace and the stable
//! backend account ID. Neither value is derived from machine hardware or from
//! a token. Only the bearer token and its server-provided expiry are persisted;
//! the API key is fetched again from the Worker when the Runtime restores.

use std::{error::Error, fmt};

use keyring::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};

const SERVICE_PREFIX: &str = "dev.cheapai.desktop";
const MAX_NAMESPACE_LENGTH: usize = 128;
const RECORD_VERSION: u8 = 1;

/// Credentials kept inside the native host and Runtime boundary.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct StoredCredentials {
    /// Opaque Worker bearer token. Never send this value to the renderer.
    pub(crate) token: String,
    /// Worker-provided token expiry, preserved in the API's timestamp unit.
    pub(crate) expires_at: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CredentialRecord {
    version: u8,
    token: String,
    expires_at: u64,
}

/// A keyring failure that can be safely reported without exposing a secret.
#[derive(Debug)]
pub(crate) enum CredentialStoreError {
    InvalidNamespace(&'static str),
    InvalidCredential,
    UnsupportedRecordVersion(u8),
    Keyring(KeyringError),
    Serialization(serde_json::Error),
}

impl fmt::Display for CredentialStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidNamespace(field) => write!(formatter, "invalid credential {field}"),
            Self::InvalidCredential => formatter.write_str("invalid stored credential"),
            Self::UnsupportedRecordVersion(version) => {
                write!(formatter, "unsupported credential record version {version}")
            }
            Self::Keyring(error) => write!(formatter, "OS credential store failed: {error}"),
            Self::Serialization(error) => write!(formatter, "credential record is invalid: {error}"),
        }
    }
}

impl Error for CredentialStoreError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Keyring(error) => Some(error),
            Self::Serialization(error) => Some(error),
            _ => None,
        }
    }
}

/// Access the current installation's credentials in the OS secure store.
///
/// `installation_id` must be a stable random ID kept in app data. It separates
/// this installation from another copy of the app running under the same OS
/// account without creating a hardware fingerprint.
pub(crate) struct CredentialStore {
    service: String,
}

impl CredentialStore {
    pub(crate) fn new(installation_id: &str) -> Result<Self, CredentialStoreError> {
        validate_namespace_part("installation ID", installation_id)?;
        Ok(Self {
            service: format!("{SERVICE_PREFIX}.{installation_id}"),
        })
    }

    /// Save a token after the Runtime has durably accepted a successful login.
    pub(crate) fn save(
        &self,
        account_id: &str,
        credentials: &StoredCredentials,
    ) -> Result<(), CredentialStoreError> {
        validate_namespace_part("account ID", account_id)?;
        if credentials.token.is_empty() || credentials.expires_at == 0 {
            return Err(CredentialStoreError::InvalidCredential);
        }

        let record = CredentialRecord {
            version: RECORD_VERSION,
            token: credentials.token.clone(),
            expires_at: credentials.expires_at,
        };
        let password = serde_json::to_string(&record).map_err(CredentialStoreError::Serialization)?;
        self.entry(account_id)?
            .set_password(&password)
            .map_err(CredentialStoreError::Keyring)
    }

    /// Read the token for one stable backend account ID.
    pub(crate) fn load(
        &self,
        account_id: &str,
    ) -> Result<Option<StoredCredentials>, CredentialStoreError> {
        validate_namespace_part("account ID", account_id)?;
        let password = match self.entry(account_id)?.get_password() {
            Ok(password) => password,
            Err(KeyringError::NoEntry) => return Ok(None),
            Err(error) => return Err(CredentialStoreError::Keyring(error)),
        };

        let record: CredentialRecord =
            serde_json::from_str(&password).map_err(CredentialStoreError::Serialization)?;
        if record.version != RECORD_VERSION {
            return Err(CredentialStoreError::UnsupportedRecordVersion(record.version));
        }
        if record.token.is_empty() || record.expires_at == 0 {
            return Err(CredentialStoreError::InvalidCredential);
        }
        Ok(Some(StoredCredentials {
            token: record.token,
            expires_at: record.expires_at,
        }))
    }

    /// Remove one account's credential. Removing an absent entry is idempotent.
    pub(crate) fn delete(&self, account_id: &str) -> Result<(), CredentialStoreError> {
        validate_namespace_part("account ID", account_id)?;
        match self.entry(account_id)?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(error) => Err(CredentialStoreError::Keyring(error)),
        }
    }

    fn entry(&self, account_id: &str) -> Result<Entry, CredentialStoreError> {
        Entry::new(&self.service, account_id).map_err(CredentialStoreError::Keyring)
    }
}

fn validate_namespace_part(
    field: &'static str,
    value: &str,
) -> Result<(), CredentialStoreError> {
    if value.is_empty()
        || value.len() > MAX_NAMESPACE_LENGTH
        || value == "."
        || value == ".."
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(CredentialStoreError::InvalidNamespace(field));
    }
    Ok(())
}
