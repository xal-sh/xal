use super::*;

#[napi(object)]
#[derive(Clone)]
pub struct NativeGitlink {
    pub path: String,
    pub before: String,
    pub after: String,
}

#[napi(object)]
pub struct NativeGitSnapshot {
    pub before: String,
    pub after: String,
    pub paths: Vec<String>,
    pub index: Buffer,
    pub gitlinks: Vec<NativeGitlink>,
    pub forced: Vec<String>,
}

#[napi(object)]
pub struct NativeCaptureRequest {
    pub forced: Vec<String>,
    pub full: bool,
}

#[napi(object)]
pub struct NativeTreePairRequest {
    pub before: String,
    pub after: String,
}

#[napi(object)]
pub struct NativeGitlinksRequest {
    pub before: String,
    pub after: String,
    pub paths: Vec<String>,
}

#[napi(object)]
pub struct NativeApplySnapshotRequest {
    pub snapshot: NativeGitSnapshot,
    pub reverse: bool,
}

impl From<NativeCaptureRequest> for service::CaptureRequest {
    fn from(value: NativeCaptureRequest) -> Self {
        Self {
            forced: value.forced,
            full: value.full,
        }
    }
}

impl From<NativeTreePairRequest> for service::TreePairRequest {
    fn from(value: NativeTreePairRequest) -> Self {
        Self {
            before: value.before,
            after: value.after,
        }
    }
}

impl From<NativeGitlinksRequest> for service::GitlinksRequest {
    fn from(value: NativeGitlinksRequest) -> Self {
        Self {
            before: value.before,
            after: value.after,
            paths: value.paths,
        }
    }
}

impl From<NativeApplySnapshotRequest> for service::ApplySnapshotRequest {
    fn from(value: NativeApplySnapshotRequest) -> Self {
        Self {
            snapshot: value.snapshot.into(),
            reverse: value.reverse,
        }
    }
}

impl From<NativeGitSnapshot> for service::GitSnapshot {
    fn from(value: NativeGitSnapshot) -> Self {
        Self {
            before: value.before,
            after: value.after,
            paths: value.paths,
            index: value.index.to_vec(),
            gitlinks: value.gitlinks.into_iter().map(Into::into).collect(),
            forced: value.forced,
        }
    }
}

impl From<NativeGitlink> for service::Gitlink {
    fn from(value: NativeGitlink) -> Self {
        Self {
            path: value.path,
            before: value.before,
            after: value.after,
        }
    }
}

impl From<service::Gitlink> for NativeGitlink {
    fn from(value: service::Gitlink) -> Self {
        Self {
            path: value.path,
            before: value.before,
            after: value.after,
        }
    }
}
