//! A single error type for every Tauri command.
//!
//! Tauri requires command errors to be `serde::Serialize`. We map the handful of
//! underlying error sources into a flat, frontend-friendly shape: `{ kind, message }`.

use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("git error: {0}")]
    Git(#[from] git2::Error),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("{0}")]
    NotFound(String),

    #[error("{0}")]
    Invalid(String),

    #[error("{0}")]
    Pty(String),

    #[error("{0}")]
    Other(String),
}

impl AppError {
    fn kind(&self) -> &'static str {
        match self {
            AppError::Git(_) => "git",
            AppError::Io(_) => "io",
            AppError::NotFound(_) => "not_found",
            AppError::Invalid(_) => "invalid",
            AppError::Pty(_) => "pty",
            AppError::Other(_) => "other",
        }
    }
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("AppError", 2)?;
        s.serialize_field("kind", self.kind())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_to_kind_and_message() {
        let err = AppError::NotFound("worktree 'x' not found".into());
        let v: serde_json::Value = serde_json::to_value(&err).unwrap();
        assert_eq!(v["kind"], "not_found");
        assert_eq!(v["message"], "worktree 'x' not found");
    }

    #[test]
    fn kind_strings_are_stable_for_the_frontend() {
        assert_eq!(AppError::Invalid("x".into()).kind(), "invalid");
        assert_eq!(AppError::Pty("x".into()).kind(), "pty");
        assert_eq!(AppError::Other("x".into()).kind(), "other");
        assert_eq!(AppError::NotFound("x".into()).kind(), "not_found");
    }

    #[test]
    fn io_errors_convert_and_serialize() {
        let io = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "nope");
        let err: AppError = io.into();
        assert_eq!(err.kind(), "io");
        let v = serde_json::to_value(&err).unwrap();
        assert!(v["message"].as_str().unwrap().contains("io error"));
    }

    #[test]
    fn git_errors_convert_to_git_kind() {
        let bad = git2::Oid::from_str("not-a-valid-oid").unwrap_err();
        let err: AppError = bad.into();
        assert_eq!(err.kind(), "git");
        let v = serde_json::to_value(&err).unwrap();
        assert!(v["message"].as_str().unwrap().starts_with("git error:"));
    }
}
