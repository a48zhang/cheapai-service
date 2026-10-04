//! Native owner of the private desktop account credential and public account
//! projection. Tokens and passwords cross only the Runtime control pipe.

use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::{
    credentials::{CredentialStore, StoredCredentials},
    runtime::{NativeHostError, RuntimeHost},
};

const ACCOUNT_STATE_EVENT: &str = "desktop-account-state";
const INSTALLATION_ID_FILE: &str = "desktop-installation-id";
const ACTIVE_ACCOUNT_FILE: &str = "desktop-active-account.json";
const MAX_METADATA_BYTES: u64 = 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone)]
pub(crate) struct AccountHost {
    inner: std::sync::Arc<AccountHostInner>,
}

struct AccountHostInner {
    credential_store: CredentialStore,
    active_account_path: PathBuf,
    operation: Mutex<()>,
    state: Mutex<AccountHostState>,
}

struct AccountHostState {
    active_account_id: Option<String>,
    public_state: Option<DesktopPublicAccountState>,
    process_epoch: u64,
    deferred_state: Option<(u64, DesktopPublicAccountState)>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub(crate) enum DesktopPublicAccountState {
    SignedOut,
    Restoring,
    SignedIn {
        account: DesktopAccountData,
        #[serde(rename = "expiresAt")]
        expires_at: u64,
    },
    Unavailable {
        account: Option<DesktopAccountData>,
        #[serde(rename = "expiresAt")]
        expires_at: Option<u64>,
        problem: DesktopAccountProblem,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DesktopAccountProblem {
    Network,
    ServiceUnavailable,
    SessionExpired,
    KeyRevoked,
    InsufficientBalance,
    GroupUnavailable,
    NoModels,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DesktopAccountData {
    user: DesktopPublicUser,
    balance: DesktopBalance,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DesktopPublicUser {
    id: String,
    email_normalized: String,
    role: String,
    status: String,
    group_id: String,
    group_status: String,
    balance_units: String,
    email_verified_at: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DesktopBalance {
    currency: String,
    decimals: u8,
    balance_units: String,
    balance_usd: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DesktopLoginResponse {
    token: String,
    #[serde(rename = "expiresAt")]
    expires_at: u64,
    user: DesktopPublicUser,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActiveAccountRecord {
    version: u8,
    account_id: String,
}

impl AccountHost {
    pub(crate) fn new(app: &AppHandle) -> Result<Self, NativeHostError> {
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|_| account_storage_error())?;
        fs::create_dir_all(&data_dir).map_err(|_| account_storage_error())?;

        let installation_id = load_or_create_installation_id(&data_dir)?;
        let credential_store =
            CredentialStore::new(&installation_id).map_err(|_| account_storage_error())?;
        let active_account_path = data_dir.join(ACTIVE_ACCOUNT_FILE);
        let active_account_id = read_active_account_id(&active_account_path)?;

        Ok(Self {
            inner: std::sync::Arc::new(AccountHostInner {
                credential_store,
                active_account_path,
                operation: Mutex::new(()),
                state: Mutex::new(AccountHostState {
                    active_account_id,
                    public_state: None,
                    process_epoch: 0,
                    deferred_state: None,
                }),
            }),
        })
    }

    /// Accept only identity-bound safe projections from the current Runtime.
    /// While a native account command is running, the command result is the
    /// single publication point and Runtime events are intentionally dropped.
    pub(crate) async fn accept_runtime_state(
        &self,
        state: Value,
        process_epoch: u64,
        app: &AppHandle,
    ) {
        if process_epoch == 0 {
            return;
        }
        let operation = self.inner.operation.try_lock().ok();
        let Ok(state) = parse_public_state(state) else {
            return;
        };

        let mut current = self.inner.state.lock().await;
        if process_epoch < current.process_epoch {
            return;
        }
        current.process_epoch = process_epoch;
        let matches_active = current.active_account_id.as_deref().is_some_and(|active_id| {
            state
                .account_id()
                .is_some_and(|state_id| state_id == active_id)
                || matches!(
                    &state,
                    DesktopPublicAccountState::Unavailable {
                        account: None,
                        problem: DesktopAccountProblem::SessionExpired,
                        ..
                    }
                )
        });
        if !matches_active {
            return;
        }
        if operation.is_none() {
            current.deferred_state = Some((process_epoch, state));
            drop(current);
            let host = self.clone();
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                host.flush_deferred_state(&app).await;
            });
            return;
        }
        current.public_state = Some(state.clone());
        current.deferred_state = None;
        drop(current);
        let _ = app.emit(ACCOUNT_STATE_EVENT, state);
    }

    async fn login(
        &self,
        runtime: &RuntimeHost,
        app: &AppHandle,
        email: String,
        password: String,
    ) -> Result<DesktopPublicAccountState, NativeHostError> {
        let _operation = self.inner.operation.lock().await;
        let (previous_account_id, previous_public_state) = {
            let mut current = self.inner.state.lock().await;
            current.deferred_state = None;
            (
                current.active_account_id.clone(),
                current.public_state.clone(),
            )
        };
        if email.is_empty()
            || email.len() > 320
            || password.len() > 256
            || has_control_characters(&email)
            || has_control_characters(&password)
        {
            return Err(invalid_account_request());
        }

        let value = match runtime
            .request_account("login", json!({ "email": email, "password": password }))
            .await
        {
            Ok(value) => value,
            Err(error) => {
                self.recover_failed_login(
                    app,
                    previous_account_id.clone(),
                    previous_public_state.clone(),
                    &error.code,
                )
                .await;
                return Err(error);
            }
        };
        let login = match parse_login_response(value) {
            Ok(login) => login,
            Err(error) => {
                self.recover_failed_login(
                    app,
                    previous_account_id.clone(),
                    previous_public_state.clone(),
                    &error.code,
                )
                .await;
                return Err(error);
            }
        };
        let account_id = login.user.id.clone();
        let login_account = account_data_from_user(login.user.clone());
        let credential = StoredCredentials {
            token: login.token,
            expires_at: login.expires_at,
        };

        // Keep enough information to roll back a same-account replacement if
        // the account-id metadata cannot be committed.
        let previous_credentials = match self.inner.credential_store.load(&account_id) {
            Ok(credentials) => credentials,
            Err(_) => {
                let error = account_storage_error();
                self.recover_failed_login(
                    app,
                    previous_account_id.clone(),
                    previous_public_state.clone(),
                    &error.code,
                )
                .await;
                return Err(error);
            }
        };
        if self.inner
            .credential_store
            .save(&account_id, &credential)
            .is_err()
        {
            let error = account_storage_error();
            self.recover_failed_login(
                app,
                previous_account_id.clone(),
                previous_public_state.clone(),
                &error.code,
            )
            .await;
            return Err(error);
        }
        if write_active_account_id(&self.inner.active_account_path, &account_id).is_err() {
            match previous_credentials {
                Some(previous) => {
                    let _ = self.inner.credential_store.save(&account_id, &previous);
                }
                None => {
                    let _ = self.inner.credential_store.delete(&account_id);
                }
            }
            let error = account_storage_error();
            self.recover_failed_login(
                app,
                previous_account_id,
                previous_public_state,
                &error.code,
            )
            .await;
            return Err(error);
        }
        self.inner.state.lock().await.active_account_id = Some(account_id.clone());

        // Persisting is a prerequisite to activation. Runtime restore binds the
        // account-scoped home and provider only after the native save succeeds.
        let restored = match runtime
            .request_account(
                "restore",
                json!({ "token": credential.token, "expiresAt": credential.expires_at }),
            )
            .await
        {
            Ok(value) => value,
            Err(error) => {
                if let Some(state) = self.take_deferred_state(&account_id).await {
                    if matches!(
                        &state,
                        DesktopPublicAccountState::Unavailable {
                            problem: DesktopAccountProblem::SessionExpired,
                            ..
                        }
                    ) {
                        if self.inner.credential_store.delete(&account_id).is_ok()
                            && remove_active_account_id(&self.inner.active_account_path).is_ok()
                        {
                            let signed_out = DesktopPublicAccountState::SignedOut;
                            self.publish_state(app, None, signed_out.clone()).await;
                            return Ok(signed_out);
                        }
                    }
                    self.publish_state(app, Some(account_id), state.clone()).await;
                    return Ok(state);
                }
                let problem = account_problem_from_code(&error.code);
                let state = if problem == DesktopAccountProblem::NoModels {
                    DesktopPublicAccountState::Unavailable {
                        account: login_account.clone(),
                        expires_at: Some(credential.expires_at),
                        problem,
                    }
                } else {
                    self.unavailable_state(None, Some(credential.expires_at), problem)
                        .await
                };
                self.publish_state(app, Some(account_id), state.clone()).await;
                if problem == DesktopAccountProblem::NoModels {
                    return Ok(state);
                }
                return Err(error);
            }
        };
        let mut public_state = match parse_public_state(restored) {
            Ok(state) => state,
            Err(error) => {
                let state = self
                    .unavailable_state(
                        None,
                        Some(credential.expires_at),
                        DesktopAccountProblem::ServiceUnavailable,
                    )
                    .await;
                self.publish_state(app, Some(account_id), state).await;
                return Err(error);
            }
        };
        if let Some(deferred) = self.take_deferred_state(&account_id).await {
            public_state = deferred;
        }
        if matches!(
            &public_state,
            DesktopPublicAccountState::Unavailable {
                account: None,
                problem: DesktopAccountProblem::NoModels,
                ..
            }
        ) {
            public_state = DesktopPublicAccountState::Unavailable {
                account: login_account.clone(),
                expires_at: Some(credential.expires_at),
                problem: DesktopAccountProblem::NoModels,
            };
        }
        if !matches!(
            &public_state,
            DesktopPublicAccountState::SignedIn { account, .. }
                if account.user.id == account_id
        ) && !matches!(
            &public_state,
            DesktopPublicAccountState::Unavailable {
                account: Some(account),
                problem: DesktopAccountProblem::NoModels,
                ..
            } if account.user.id == account_id
        ) {
            let state = self
                .unavailable_state(
                    None,
                    Some(credential.expires_at),
                    DesktopAccountProblem::ServiceUnavailable,
                )
                .await;
            self.publish_state(app, Some(account_id), state).await;
            return Err(invalid_account_response());
        }
        self.publish_state(app, Some(account_id), public_state.clone())
            .await;
        Ok(public_state)
    }

    async fn restore(
        &self,
        runtime: &RuntimeHost,
        app: &AppHandle,
    ) -> Result<DesktopPublicAccountState, NativeHostError> {
        let _operation = self.inner.operation.lock().await;
        self.begin_operation().await;
        let Some(account_id) = read_active_account_id(&self.inner.active_account_path)? else {
            let state = DesktopPublicAccountState::SignedOut;
            self.publish_state(app, None, state.clone()).await;
            return Ok(state);
        };

        let credential = self
            .inner
            .credential_store
            .load(&account_id)
            .map_err(|_| account_storage_error())?;
        let Some(credential) = credential else {
            if remove_active_account_id(&self.inner.active_account_path).is_err() {
                let state = self
                    .unavailable_state(
                        None,
                        None,
                        DesktopAccountProblem::ServiceUnavailable,
                    )
                    .await;
                self.publish_state(app, Some(account_id), state.clone()).await;
                return Ok(state);
            }
            let state = DesktopPublicAccountState::SignedOut;
            self.publish_state(app, None, state.clone()).await;
            return Ok(state);
        };

        let restored = runtime
            .request_account(
                "restore",
                json!({ "token": credential.token, "expiresAt": credential.expires_at }),
            )
            .await;
        let mut state = match restored {
            Ok(value) => {
                let state = parse_public_state(value)?;
                if let Some(returned_id) = state.account_id() {
                    if returned_id != account_id {
                        return Err(invalid_account_response());
                    }
                }
                if !matches!(
                    &state,
                    DesktopPublicAccountState::SignedIn { .. }
                        | DesktopPublicAccountState::Unavailable { .. }
                ) {
                    return Err(invalid_account_response());
                }
                state
            }
            Err(error) => {
                if let Some(state) = self.take_deferred_state(&account_id).await {
                    if matches!(
                        &state,
                        DesktopPublicAccountState::Unavailable {
                            problem: DesktopAccountProblem::SessionExpired,
                            ..
                        }
                    ) && self.inner.credential_store.delete(&account_id).is_ok()
                        && remove_active_account_id(&self.inner.active_account_path).is_ok()
                    {
                        let signed_out = DesktopPublicAccountState::SignedOut;
                        self.publish_state(app, None, signed_out.clone()).await;
                        return Ok(signed_out);
                    }
                    self.publish_state(app, Some(account_id), state.clone()).await;
                    return Ok(state);
                }
                let problem = account_problem_from_code(&error.code);
                if problem == DesktopAccountProblem::SessionExpired {
                    // The Runtime has already stopped/unbound this expired
                    // session. Remove its Token before reporting signedOut.
                    if self.inner.credential_store.delete(&account_id).is_ok()
                        && remove_active_account_id(&self.inner.active_account_path).is_ok()
                    {
                        let state = DesktopPublicAccountState::SignedOut;
                        self.publish_state(app, None, state.clone()).await;
                        return Ok(state);
                    }
                }
                self.unavailable_state(
                    None,
                    Some(credential.expires_at),
                    problem,
                )
                .await
            }
        };
        if let Some(deferred) = self.take_deferred_state(&account_id).await {
            state = deferred;
        }
        if matches!(
            &state,
            DesktopPublicAccountState::Unavailable {
                problem: DesktopAccountProblem::SessionExpired,
                ..
            }
        ) && self.inner.credential_store.delete(&account_id).is_ok()
            && remove_active_account_id(&self.inner.active_account_path).is_ok()
        {
            let signed_out = DesktopPublicAccountState::SignedOut;
            self.publish_state(app, None, signed_out.clone()).await;
            return Ok(signed_out);
        }
        self.publish_state(app, Some(account_id), state.clone()).await;
        Ok(state)
    }

    async fn refresh(
        &self,
        runtime: &RuntimeHost,
        app: &AppHandle,
    ) -> Result<DesktopPublicAccountState, NativeHostError> {
        let _operation = self.inner.operation.lock().await;
        self.begin_operation().await;
        let account_id = read_active_account_id(&self.inner.active_account_path)?
            .ok_or_else(|| no_active_account())?;
        let credential = self
            .inner
            .credential_store
            .load(&account_id)
            .map_err(|_| account_storage_error())?
            .ok_or_else(no_active_account)?;

        let result = runtime
            .request_account(
                "getAccount",
                json!({ "token": credential.token, "expiresAt": credential.expires_at }),
            )
            .await;
        let mut state = match result {
            Ok(value) => {
                let account = parse_account_data(value)?;
                if account.user.id != account_id {
                    return Err(invalid_account_response());
                }
                DesktopPublicAccountState::SignedIn {
                    account,
                    expires_at: credential.expires_at,
                }
            }
            Err(error) => {
                if let Some(state) = self.take_deferred_state(&account_id).await {
                    self.publish_state(app, Some(account_id), state.clone()).await;
                    return Ok(state);
                }
                let problem = account_problem_from_code(&error.code);
                let previous = self.current_public_state().await;
                self.unavailable_state(previous.as_ref(), Some(credential.expires_at), problem)
                    .await
            }
        };
        if let Some(deferred) = self.take_deferred_state(&account_id).await {
            state = deferred;
        }
        self.publish_state(app, Some(account_id), state.clone()).await;
        Ok(state)
    }

    async fn logout(
        &self,
        runtime: &RuntimeHost,
        app: &AppHandle,
    ) -> Result<DesktopPublicAccountState, NativeHostError> {
        let _operation = self.inner.operation.lock().await;
        self.begin_operation().await;
        let Some(account_id) = read_active_account_id(&self.inner.active_account_path)? else {
            let state = DesktopPublicAccountState::SignedOut;
            self.publish_state(app, None, state.clone()).await;
            return Ok(state);
        };
        let credential = self
            .inner
            .credential_store
            .load(&account_id)
            .map_err(|_| account_storage_error())?;

        let Some(credential) = credential else {
            return Err(no_active_account());
        };
        {
            let result = runtime
                .request_account(
                    "logout",
                    json!({ "token": credential.token, "expiresAt": credential.expires_at }),
                )
                .await;
            let value = match result {
                Ok(value) => value,
                Err(error) => {
                    if let Some(state) = self.take_deferred_state(&account_id).await {
                        self.publish_state(app, Some(account_id), state.clone()).await;
                        return Ok(state);
                    }
                    let problem = account_problem_from_code(&error.code);
                    let previous = self.current_public_state().await;
                    let state = self
                        .unavailable_state(previous.as_ref(), Some(credential.expires_at), problem)
                        .await;
                    self.publish_state(app, Some(account_id), state.clone()).await;
                    return Ok(state);
                }
            };
            if !is_logged_out_result(&value) {
                return Err(invalid_account_response());
            }

            // Do not publish signedOut unless both local stores have completed
            // their deletion after Runtime revoke/stop/unbind succeeded.
            if self.inner.credential_store.delete(&account_id).is_err() {
                let state = DesktopPublicAccountState::Unavailable {
                    account: None,
                    expires_at: None,
                    problem: DesktopAccountProblem::ServiceUnavailable,
                };
                self.publish_state(app, Some(account_id), state.clone()).await;
                return Ok(state);
            }
        }

        if remove_active_account_id(&self.inner.active_account_path).is_err() {
            let previous = self.current_public_state().await;
            let (account, expires_at) = state_account_and_expiry(previous.as_ref());
            let state = DesktopPublicAccountState::Unavailable {
                account,
                expires_at,
                problem: DesktopAccountProblem::ServiceUnavailable,
            };
            self.publish_state(app, Some(account_id), state.clone()).await;
            return Ok(state);
        }

        let state = DesktopPublicAccountState::SignedOut;
        self.publish_state(app, None, state.clone()).await;
        Ok(state)
    }

    async fn publish_state(
        &self,
        app: &AppHandle,
        active_account_id: Option<String>,
        state: DesktopPublicAccountState,
    ) {
        {
            let mut current = self.inner.state.lock().await;
            current.active_account_id = active_account_id;
            current.public_state = Some(state.clone());
            current.deferred_state = None;
        }
        let _ = app.emit(ACCOUNT_STATE_EVENT, state);
    }

    async fn recover_failed_login(
        &self,
        app: &AppHandle,
        previous_account_id: Option<String>,
        previous_public_state: Option<DesktopPublicAccountState>,
        error_code: &str,
    ) {
        let mut state = if let Some(account_id) = previous_account_id.as_deref() {
            let deferred = self.take_deferred_state(account_id).await;
            deferred
                .filter(|state| state_belongs_to_account(state, account_id))
                .or_else(|| {
                    previous_public_state
                        .filter(|state| state_belongs_to_account(state, account_id))
                })
                .unwrap_or(DesktopPublicAccountState::Unavailable {
                    account: None,
                    expires_at: None,
                    problem: account_problem_from_code(error_code),
                })
        } else {
            self.inner.state.lock().await.deferred_state = None;
            DesktopPublicAccountState::SignedOut
        };
        let mut active_account_id = previous_account_id;
        if matches!(
            &state,
            DesktopPublicAccountState::Unavailable {
                account: None,
                problem: DesktopAccountProblem::SessionExpired,
                ..
            }
        ) {
            if let Some(account_id) = active_account_id.as_deref() {
                if self.inner.credential_store.delete(account_id).is_ok()
                    && remove_active_account_id(&self.inner.active_account_path).is_ok()
                {
                    active_account_id = None;
                    state = DesktopPublicAccountState::SignedOut;
                }
            }
        }
        self.publish_state(app, active_account_id, state).await;
    }

    async fn current_public_state(&self) -> Option<DesktopPublicAccountState> {
        self.inner.state.lock().await.public_state.clone()
    }

    async fn begin_operation(&self) {
        self.inner.state.lock().await.deferred_state = None;
    }

    async fn take_deferred_state(
        &self,
        expected_account_id: &str,
    ) -> Option<DesktopPublicAccountState> {
        let mut current = self.inner.state.lock().await;
        let (epoch, state) = current.deferred_state.take()?;
        let identity_matches = state.account_id() == Some(expected_account_id)
            || (matches!(
                &state,
                DesktopPublicAccountState::Unavailable {
                    account: None,
                    problem: DesktopAccountProblem::SessionExpired,
                    ..
                }
            ) && current.active_account_id.as_deref() == Some(expected_account_id));
        if epoch == current.process_epoch && identity_matches {
            Some(state)
        } else {
            None
        }
    }

    async fn flush_deferred_state(&self, app: &AppHandle) {
        let _operation = self.inner.operation.lock().await;
        let state = {
            let mut current = self.inner.state.lock().await;
            let Some((epoch, state)) = current.deferred_state.take() else {
                return;
            };
            let identity_matches = current.active_account_id.as_deref().is_some_and(|active_id| {
                state
                    .account_id()
                    .is_some_and(|state_id| state_id == active_id)
                    || matches!(
                        &state,
                        DesktopPublicAccountState::Unavailable {
                            account: None,
                            problem: DesktopAccountProblem::SessionExpired,
                            ..
                        }
                    )
            });
            if epoch != current.process_epoch || !identity_matches {
                return;
            }
            current.public_state = Some(state.clone());
            state
        };
        let _ = app.emit(ACCOUNT_STATE_EVENT, state);
    }

    async fn unavailable_state(
        &self,
        previous: Option<&DesktopPublicAccountState>,
        fallback_expiry: Option<u64>,
        problem: DesktopAccountProblem,
    ) -> DesktopPublicAccountState {
        if problem == DesktopAccountProblem::SessionExpired {
            return DesktopPublicAccountState::Unavailable {
                account: None,
                expires_at: None,
                problem,
            };
        }
        let (account, expires_at) = state_account_and_expiry(previous);
        DesktopPublicAccountState::Unavailable {
            account,
            expires_at: expires_at.or(fallback_expiry),
            problem,
        }
    }
}

#[tauri::command]
pub(crate) async fn desktop_account_login(
    account: State<'_, AccountHost>,
    runtime: State<'_, RuntimeHost>,
    app: AppHandle,
    email: String,
    password: String,
) -> Result<DesktopPublicAccountState, NativeHostError> {
    account.login(&runtime, &app, email, password).await
}

#[tauri::command]
pub(crate) async fn desktop_account_restore(
    account: State<'_, AccountHost>,
    runtime: State<'_, RuntimeHost>,
    app: AppHandle,
) -> Result<DesktopPublicAccountState, NativeHostError> {
    account.restore(&runtime, &app).await
}

#[tauri::command]
pub(crate) async fn desktop_account_refresh(
    account: State<'_, AccountHost>,
    runtime: State<'_, RuntimeHost>,
    app: AppHandle,
) -> Result<DesktopPublicAccountState, NativeHostError> {
    account.refresh(&runtime, &app).await
}

#[tauri::command]
pub(crate) async fn desktop_account_logout(
    account: State<'_, AccountHost>,
    runtime: State<'_, RuntimeHost>,
    app: AppHandle,
) -> Result<DesktopPublicAccountState, NativeHostError> {
    account.logout(&runtime, &app).await
}

fn load_or_create_installation_id(data_dir: &Path) -> Result<String, NativeHostError> {
    let path = data_dir.join(INSTALLATION_ID_FILE);
    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(true);
    set_private_mode(&mut options);

    match options.open(&path) {
        Ok(mut file) => {
            let id = Uuid::new_v4().to_string();
            if file.write_all(id.as_bytes()).is_err() || file.sync_all().is_err() {
                let _ = fs::remove_file(path);
                return Err(account_storage_error());
            }
            Ok(id)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let value = read_limited_file(&path)?;
            let id = value.trim();
            if value.trim() != value || Uuid::parse_str(id).is_err() {
                return Err(account_storage_error());
            }
            Ok(id.to_owned())
        }
        Err(_) => Err(account_storage_error()),
    }
}

fn read_active_account_id(path: &Path) -> Result<Option<String>, NativeHostError> {
    let value = match read_limited_file(path) {
        Ok(value) => value,
        Err(error) if error.code == "account-metadata-missing" => return Ok(None),
        Err(error) => return Err(error),
    };
    let record: ActiveAccountRecord =
        serde_json::from_str(&value).map_err(|_| account_storage_error())?;
    if record.version != 1 || !is_account_id(&record.account_id) {
        return Err(account_storage_error());
    }
    Ok(Some(record.account_id))
}

fn write_active_account_id(path: &Path, account_id: &str) -> Result<(), NativeHostError> {
    if !is_account_id(account_id) {
        return Err(account_storage_error());
    }
    let record = ActiveAccountRecord {
        version: 1,
        account_id: account_id.to_owned(),
    };
    let contents = serde_json::to_vec(&record).map_err(|_| account_storage_error())?;
    let parent = path.parent().ok_or_else(account_storage_error)?;
    let temporary = parent.join(format!(".desktop-account-{}.tmp", Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    set_private_mode(&mut options);
    let mut file = options
        .open(&temporary)
        .map_err(|_| account_storage_error())?;
    if file.write_all(&contents).is_err() || file.sync_all().is_err() {
        let _ = fs::remove_file(&temporary);
        return Err(account_storage_error());
    }

    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(path).map_err(|_| {
            let _ = fs::remove_file(&temporary);
            account_storage_error()
        })?;
    }
    if fs::rename(&temporary, path).is_err() {
        let _ = fs::remove_file(&temporary);
        return Err(account_storage_error());
    }
    Ok(())
}

fn remove_active_account_id(path: &Path) -> Result<(), NativeHostError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(account_storage_error()),
    }
}

fn read_limited_file(path: &Path) -> Result<String, NativeHostError> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(NativeHostError::new(
                "account-metadata-missing",
                "Desktop account metadata is unavailable",
            ));
        }
        Err(_) => return Err(account_storage_error()),
    };
    if file
        .metadata()
        .map_err(|_| account_storage_error())?
        .len()
        > MAX_METADATA_BYTES
    {
        return Err(account_storage_error());
    }
    let mut contents = String::new();
    file.take(MAX_METADATA_BYTES + 1)
        .read_to_string(&mut contents)
        .map_err(|_| account_storage_error())?;
    if contents.len() as u64 > MAX_METADATA_BYTES {
        return Err(account_storage_error());
    }
    Ok(contents)
}

fn parse_login_response(value: Value) -> Result<DesktopLoginResponse, NativeHostError> {
    let object = value.as_object().ok_or_else(invalid_account_response)?;
    ensure_exact_fields(object, &["token", "expiresAt", "user"])?;
    ensure_public_user_fields(
        object
            .get("user")
            .and_then(Value::as_object)
            .ok_or_else(invalid_account_response)?,
    )?;
    let response: DesktopLoginResponse =
        serde_json::from_value(value).map_err(|_| invalid_account_response())?;
    if !is_credential(&response.token)
        || !is_safe_timestamp(response.expires_at)
        || response.expires_at == 0
        || !is_public_user(&response.user)
        || !is_account_id(&response.user.id)
    {
        return Err(invalid_account_response());
    }
    Ok(response)
}

fn parse_public_state(value: Value) -> Result<DesktopPublicAccountState, NativeHostError> {
    let object = value.as_object().ok_or_else(invalid_account_response)?;
    let status = object
        .get("status")
        .and_then(Value::as_str)
        .ok_or_else(invalid_account_response)?;
    match status {
        "signedOut" => {
            ensure_exact_fields(object, &["status"])?;
            Ok(DesktopPublicAccountState::SignedOut)
        }
        "restoring" => {
            ensure_exact_fields(object, &["status"])?;
            Ok(DesktopPublicAccountState::Restoring)
        }
        "signedIn" => {
            ensure_exact_fields(object, &["status", "account", "expiresAt"])?;
            let account = parse_account_data(
                object
                    .get("account")
                    .cloned()
                    .ok_or_else(invalid_account_response)?,
            )?;
            let expires_at = parse_timestamp(
                object
                    .get("expiresAt")
                    .ok_or_else(invalid_account_response)?,
            )?;
            Ok(DesktopPublicAccountState::SignedIn {
                account,
                expires_at,
            })
        }
        "unavailable" => {
            ensure_exact_fields(object, &["status", "account", "expiresAt", "problem"])?;
            let account = match object
                .get("account")
                .ok_or_else(invalid_account_response)?
            {
                Value::Null => None,
                value => Some(parse_account_data(value.clone())?),
            };
            let expires_at = match object
                .get("expiresAt")
                .ok_or_else(invalid_account_response)?
            {
                Value::Null => None,
                value => Some(parse_timestamp(value)?),
            };
            let problem = parse_problem(
                object
                    .get("problem")
                    .and_then(Value::as_str)
                    .ok_or_else(invalid_account_response)?,
            )
            .ok_or_else(invalid_account_response)?;
            if account.is_some() && expires_at.is_none() {
                return Err(invalid_account_response());
            }
            if problem == DesktopAccountProblem::SessionExpired
                && (account.is_some() || expires_at.is_some())
            {
                return Err(invalid_account_response());
            }
            Ok(DesktopPublicAccountState::Unavailable {
                account,
                expires_at,
                problem,
            })
        }
        _ => Err(invalid_account_response()),
    }
}

fn parse_account_data(value: Value) -> Result<DesktopAccountData, NativeHostError> {
    let object = value.as_object().ok_or_else(invalid_account_response)?;
    ensure_exact_fields(object, &["user", "balance"])?;
    ensure_public_user_fields(
        object
            .get("user")
            .and_then(Value::as_object)
            .ok_or_else(invalid_account_response)?,
    )?;
    let balance = object
        .get("balance")
        .and_then(Value::as_object)
        .ok_or_else(invalid_account_response)?;
    ensure_exact_fields(balance, &["currency", "decimals", "balance_units", "balance_usd"])?;
    let account: DesktopAccountData =
        serde_json::from_value(value).map_err(|_| invalid_account_response())?;
    if !is_public_user(&account.user)
        || !is_account_id(&account.user.id)
        || account.balance.currency != "USD"
        || account.balance.decimals != 8
        || account.balance.balance_units != account.user.balance_units
        || format_units_as_usd(&account.balance.balance_units).as_deref()
            != Some(account.balance.balance_usd.as_str())
    {
        return Err(invalid_account_response());
    }
    Ok(account)
}

fn is_logged_out_result(value: &Value) -> bool {
    value.as_object().is_some_and(|object| {
        object.len() == 1 && object.get("loggedOut") == Some(&Value::Bool(true))
    })
}

fn account_data_from_user(user: DesktopPublicUser) -> Option<DesktopAccountData> {
    let balance_usd = format_units_as_usd(&user.balance_units)?;
    Some(DesktopAccountData {
        balance: DesktopBalance {
            currency: "USD".to_owned(),
            decimals: 8,
            balance_units: user.balance_units.clone(),
            balance_usd,
        },
        user,
    })
}

/// Login includes the canonical integer balance units. Derive the USD string
/// exactly when a safe no-models projection needs to retain that account.
fn format_units_as_usd(value: &str) -> Option<String> {
    if value.is_empty() || value.len() > 128 {
        return None;
    }
    let (negative, digits) = value
        .strip_prefix('-')
        .map_or((false, value), |digits| (true, digits));
    if digits.is_empty()
        || !digits.bytes().all(|byte| byte.is_ascii_digit())
        || (digits.len() > 1 && digits.starts_with('0'))
        || (negative && digits == "0")
    {
        return None;
    }
    let padded = if digits.len() < 9 {
        format!("{}{}", "0".repeat(9 - digits.len()), digits)
    } else {
        digits.to_owned()
    };
    let split = padded.len() - 8;
    Some(format!(
        "{}{}.{}",
        if negative { "-" } else { "" },
        &padded[..split],
        &padded[split..]
    ))
}

fn ensure_exact_fields(
    object: &serde_json::Map<String, Value>,
    fields: &[&str],
) -> Result<(), NativeHostError> {
    if object.len() == fields.len() && fields.iter().all(|field| object.contains_key(*field)) {
        Ok(())
    } else {
        Err(invalid_account_response())
    }
}

fn ensure_public_user_fields(
    object: &serde_json::Map<String, Value>,
) -> Result<(), NativeHostError> {
    ensure_exact_fields(
        object,
        &[
            "id",
            "email_normalized",
            "role",
            "status",
            "group_id",
            "group_status",
            "balance_units",
            "email_verified_at",
        ],
    )
}

fn is_public_user(user: &DesktopPublicUser) -> bool {
    is_public_id(&user.id)
        && user.email_normalized.len() <= 320
        && !has_control_characters(&user.email_normalized)
        && (user.role == "user" || user.role == "admin")
        && (user.status == "active" || user.status == "disabled")
        && is_public_id(&user.group_id)
        && (user.group_status == "active" || user.group_status == "disabled")
        && format_units_as_usd(&user.balance_units).is_some()
        && user
            .email_verified_at
            .map_or(true, |value| value <= MAX_SAFE_INTEGER)
}

fn is_public_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && !has_control_characters(value)
}

fn is_account_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn is_credential(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4096
        && value.trim() == value
        && !has_control_characters(value)
}

fn has_control_characters(value: &str) -> bool {
    value.chars().any(char::is_control)
}

fn is_safe_timestamp(value: u64) -> bool {
    value <= MAX_SAFE_INTEGER
}

fn parse_timestamp(value: &Value) -> Result<u64, NativeHostError> {
    value
        .as_u64()
        .filter(|timestamp| is_safe_timestamp(*timestamp))
        .ok_or_else(invalid_account_response)
}

fn parse_problem(value: &str) -> Option<DesktopAccountProblem> {
    match value {
        "network" => Some(DesktopAccountProblem::Network),
        "serviceUnavailable" => Some(DesktopAccountProblem::ServiceUnavailable),
        "sessionExpired" => Some(DesktopAccountProblem::SessionExpired),
        "keyRevoked" => Some(DesktopAccountProblem::KeyRevoked),
        "insufficientBalance" => Some(DesktopAccountProblem::InsufficientBalance),
        "groupUnavailable" => Some(DesktopAccountProblem::GroupUnavailable),
        "noModels" => Some(DesktopAccountProblem::NoModels),
        _ => None,
    }
}

fn account_problem_from_code(code: &str) -> DesktopAccountProblem {
    parse_problem(code).unwrap_or(DesktopAccountProblem::ServiceUnavailable)
}

fn state_account_and_expiry(
    state: Option<&DesktopPublicAccountState>,
) -> (Option<DesktopAccountData>, Option<u64>) {
    match state {
        Some(DesktopPublicAccountState::SignedIn {
            account,
            expires_at,
        }) => (Some(account.clone()), Some(*expires_at)),
        Some(DesktopPublicAccountState::Unavailable {
            account,
            expires_at,
            ..
        }) => (account.clone(), *expires_at),
        _ => (None, None),
    }
}

impl DesktopPublicAccountState {
    fn account_id(&self) -> Option<&str> {
        match self {
            Self::SignedIn { account, .. } => Some(&account.user.id),
            Self::Unavailable {
                account: Some(account),
                ..
            } => Some(&account.user.id),
            Self::SignedOut | Self::Restoring | Self::Unavailable { account: None, .. } => None,
        }
    }
}

fn state_belongs_to_account(state: &DesktopPublicAccountState, account_id: &str) -> bool {
    state.account_id() == Some(account_id)
        || matches!(
            state,
            DesktopPublicAccountState::Unavailable {
                account: None,
                problem: DesktopAccountProblem::SessionExpired,
                ..
            }
        )
}

fn set_private_mode(options: &mut OpenOptions) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    #[cfg(not(unix))]
    let _ = options;
}

fn account_storage_error() -> NativeHostError {
    NativeHostError::new(
        "account-storage-failed",
        "Desktop credentials could not be stored",
    )
}

fn invalid_account_request() -> NativeHostError {
    NativeHostError::new(
        "invalid-account-request",
        "The desktop account request is invalid",
    )
}

fn invalid_account_response() -> NativeHostError {
    NativeHostError::new(
        "invalid-account-response",
        "The local Runtime returned an invalid account response",
    )
}

fn no_active_account() -> NativeHostError {
    NativeHostError::new(
        "account-not-signed-in",
        "There is no active desktop account",
    )
}
