mod accounts;
mod background;
mod headless;
mod integrations;
mod prompt;
mod sessions;
mod task_agents;

use std::env;
use std::io::{self, Write};
use std::process::ExitCode;

use xal_host::*;

fn run(args: &[String]) -> Result<String> {
    if args == ["--version"] || args == ["-v"] {
        return Ok(format!(
            "xal-rust {} (development)\n",
            env!("CARGO_PKG_VERSION")
        ));
    }
    if args.is_empty() || args == ["--help"] || args == ["-h"] {
        return Ok("xal-rust — native rewrite (development only)\n\nUsage: xal-rust <command>\n\n  --version  Print the development version\n  --help     Show this help\n  run [options] [prompt]  Run a native headless session\n  sessions  List, title, export, fork, clear or move recorded history\n  bg  Detach, inspect, stop or attach background sessions\n  connect / connections / profiles / rename / logout  Manage named connections\n  usage  Read provider request usage totals\n  models / model / thinking / context-window / compaction-limit  Configure text models\n  typesafe on|off  Configure decision inference\n  mcp / lsp  Inspect or manage native integrations\n  commands / prompt / review  List commands or preview prepared prompts\n  workspace-paths [query]  Rank workspace completion paths\n\nUse <command> --help for account options. No TUI yet. Use xal for the current application.\n".into());
    }
    Err(Error::Failed(format!("unknown command: {}", args[0])))
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let args = match env::args_os()
        .skip(1)
        .map(|arg| arg.into_string())
        .collect::<std::result::Result<Vec<_>, _>>()
    {
        Ok(args) => args,
        Err(_) => {
            eprintln!("xal-rust: arguments must be valid Unicode");
            return ExitCode::FAILURE;
        }
    };
    if args
        .first()
        .is_some_and(|arg| arg == "run" || arg == "bg" || accounts::handles(arg))
    {
        return match if args[0] == "run" {
            headless::run(&args[1..]).await
        } else if args[0] == "bg" {
            background::run(&args[1..]).await
        } else {
            accounts::run(&args).await
        } {
            Ok(code) => ExitCode::from(code),
            Err(error) => {
                eprintln!("xal-rust: {error}");
                ExitCode::FAILURE
            }
        };
    }
    let result = if args.first().is_some_and(|arg| arg == "sessions") {
        sessions::run(&args[1..])
    } else if args
        .first()
        .is_some_and(|command| integrations::handles(command))
    {
        integrations::run(&args).await
    } else {
        run(&args).map(|output| (output, 0))
    };
    match result {
        Ok((output, code)) => match io::stdout().lock().write_all(output.as_bytes()) {
            Ok(()) => ExitCode::from(code),
            Err(error) => {
                eprintln!("xal-rust: {error}");
                ExitCode::FAILURE
            }
        },
        Err(error) => {
            eprintln!("xal-rust: {error}");
            match error {
                Error::Cancelled => ExitCode::from(130),
                Error::Paused
                | Error::NeedsInput
                | Error::Failed(_)
                | Error::Denied(_)
                | Error::ApprovalRequired(_)
                | Error::Provider { .. } => ExitCode::FAILURE,
            }
        }
    }
}
