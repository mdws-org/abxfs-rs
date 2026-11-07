//! `inferMimeType` (SDK `util.ts`).

const FALLBACK: &str = "application/octet-stream";

/// Lowercase the whole path, take the text after its last `.`, look it up.
///
/// The SDK looks the extension up in a plain JS object, so an extension that names an `Object.prototype`
/// member resolves to that member, and the mime string hashed into the file CID is its `String()` form. Only
/// all-lowercase member names can match after lowercasing: `constructor` and `__proto__`.
pub fn infer_mime_type(path: &str) -> String {
    let lower = path.to_lowercase();
    let ext = lower.rsplit('.').next().unwrap_or("");
    if ext.is_empty() {
        return FALLBACK.to_string();
    }
    let m = match ext {
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" => "application/javascript",
        "json" => "application/json",
        "md" => "text/markdown",
        "txt" => "text/plain",
        "csv" => "text/csv",
        "xml" => "application/xml",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "wasm" => "application/wasm",
        "pdf" => "application/pdf",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "zip" => "application/zip",
        "gz" => "application/gzip",
        "br" => "application/brotli",
        "constructor" => "function Object() { [native code] }",
        "__proto__" => "[object Object]",
        _ => FALLBACK,
    };
    m.to_string()
}

#[cfg(test)]
mod tests {
    use super::infer_mime_type as m;

    #[test]
    fn last_dot_of_whole_path() {
        assert_eq!(m("README"), "application/octet-stream");
        assert_eq!(m("html"), "text/html");
        assert_eq!(m("a.b/c"), "application/octet-stream");
        assert_eq!(m("names/UPPER.JSON"), "application/json");
        assert_eq!(m("x."), "application/octet-stream");
    }
}
