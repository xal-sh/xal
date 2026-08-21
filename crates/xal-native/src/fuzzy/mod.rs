#![cfg_attr(test, allow(dead_code))]

use std::collections::HashSet;
use std::path::{MAIN_SEPARATOR, PathBuf};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use napi::bindgen_prelude::{AbortSignal, AsyncTask};
use napi::{Env, Error, Status, Task};
use napi_derive::napi;

use crate::redactor::SecretMatcher;
use crate::search::walk_files;
use crate::tool_contracts::{NativeToolOutcomeKind, cancellation_flag};

const CONTIGUOUS_BONUS: f64 = 8.0;
const BOUNDARY_BONUS: f64 = 6.0;
const PREFIX_BONUS: f64 = 12.0;
const EXACT_BONUS: f64 = 20.0;
const GAP_PENALTY: f64 = 1.0;
const DISTANCE_PENALTY: f64 = 0.2;
const LENGTH_PENALTY: f64 = 0.05;
const WORKSPACE_RESULT_LIMIT: usize = 20;

mod score;
mod workspace;

use score::{PreparedField, compact, score_terms, terms};
