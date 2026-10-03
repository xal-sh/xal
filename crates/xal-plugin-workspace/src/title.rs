pub fn compact(command: &str) -> String {
    let lines = command
        .split('\n')
        .map(xal_services::settings::js_trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    if lines.len() <= 1 {
        return lines.first().copied().unwrap_or("").into();
    }
    let body = lines
        .iter()
        .copied()
        .filter(|line| !boilerplate(line))
        .collect::<Vec<_>>();
    let lines = if body.is_empty() { &lines } else { &body };
    let headline = lines[0].split_whitespace().collect::<Vec<_>>().join(" ");
    if lines.len() == 1 {
        return headline;
    }
    format!("{headline} · +{} more", lines.len() - 1)
}

fn assignment(line: &str) -> bool {
    let Some((name, _)) = line.split_once('=') else {
        return false;
    };
    let mut bytes = name.bytes();
    bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn boilerplate(line: &str) -> bool {
    if line.starts_with('#') || assignment(line) && !line.chars().any(char::is_whitespace) {
        return true;
    }
    let Some((name, rest)) = line.split_once(char::is_whitespace) else {
        return false;
    };
    let rest = rest.trim_start();
    match name {
        "shopt" | "cd" => true,
        "export" => assignment(rest),
        "set" => rest
            .strip_prefix(['-', '+'])
            .and_then(|value| value.bytes().next())
            .is_some_and(|byte| byte.is_ascii_alphabetic()),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::compact;

    #[test]
    fn shell_titles_keep_meaningful_commands_and_multiline_counts() {
        assert_eq!(compact("ls -ld /tmp/example"), "ls -ld /tmp/example");
        assert_eq!(
            compact("set -e\nrm -rf /tmp/example\nmkdir /tmp/example"),
            "rm -rf /tmp/example · +1 more"
        );
        assert_eq!(
            compact("set -euo pipefail\ncd /repo\nbun run checks"),
            "bun run checks"
        );
        assert_eq!(
            compact("# prepare\nFOO=1\nexport BAR=2\n\nbun test"),
            "bun test"
        );
        assert_eq!(compact("set -e\nset -u"), "set -e · +1 more");
        assert_eq!(compact(""), "");
    }
}
