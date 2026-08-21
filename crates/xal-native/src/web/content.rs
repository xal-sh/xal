use super::*;

pub(super) fn binary_type(content_type: &str) -> bool {
    content_type.starts_with("image/")
        || content_type.starts_with("audio/")
        || content_type.starts_with("video/")
        || content_type.starts_with("font/")
        || content_type.contains("application/octet-stream")
        || content_type.contains("application/pdf")
        || content_type.contains("application/zip")
}

pub(super) fn charset(content_type: &str) -> &'static Encoding {
    let label = content_type.split(';').skip(1).find_map(|part| {
        let (name, value) = part.trim().split_once('=')?;
        if name.trim().eq_ignore_ascii_case("charset") {
            Some(value.trim().trim_matches(['\'', '"']).as_bytes())
        } else {
            None
        }
    });
    label.and_then(Encoding::for_label).unwrap_or(UTF_8)
}

fn remove_element(mut html: String, tag: &str) -> String {
    loop {
        let lower = html.to_ascii_lowercase();
        let Some(start) = lower.find(&format!("<{tag}")) else {
            return html;
        };
        let Some(open_end) = lower[start..].find('>').map(|end| start + end + 1) else {
            return html;
        };
        let Some(close) = lower[open_end..]
            .find(&format!("</{tag}>"))
            .map(|close| open_end + close + tag.len() + 3)
        else {
            html.replace_range(start..open_end, "");
            continue;
        };
        html.replace_range(start..close, "");
    }
}

pub(super) fn html_to_markdown(html: String) -> String {
    let html = ["script", "style", "noscript"]
        .into_iter()
        .fold(html, remove_element);
    let markdown = html2md::parse_html(&html);
    let lines = markdown.lines().collect::<Vec<_>>();
    let mut normalized = Vec::with_capacity(lines.len());
    let mut index = 0;
    while index < lines.len() {
        if let Some(underline) = lines.get(index + 1) {
            let marker = underline.trim();
            if !lines[index].trim().is_empty()
                && marker.len() >= 3
                && marker.chars().all(|character| character == '=')
            {
                normalized.push(format!("# {}", lines[index].trim()));
                index += 2;
                continue;
            }
            if !lines[index].trim().is_empty()
                && marker.len() >= 3
                && marker.chars().all(|character| character == '-')
            {
                normalized.push(format!("## {}", lines[index].trim()));
                index += 2;
                continue;
            }
        }
        normalized.push(lines[index].to_owned());
        index += 1;
    }
    normalized.join("\n").trim().to_owned()
}
#[napi(js_name = "nativeHtmlToMarkdown", catch_unwind)]
pub fn native_html_to_markdown(html: String) -> String {
    html_to_markdown(html)
}
