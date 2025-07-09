exports.port = process.env.PORT || 3000;
exports.enable_logging = false;
exports.fetch_regex = /^\/fetch\/(.*)$/; // The URL to look for when parsing the request.
exports.proxy_request_timeout_ms = 10000; // The lenght of time we'll wait for a proxy server to respond before timing out.
exports.max_request_length = 100000000000; // The maximum length of characters allowed for a request or a response.
exports.enable_rate_limiting = true;
exports.max_requests_per_second = 10; // The maximum number of requests per second to allow from a given IP.
exports.max_redirects = 3; // Maximum redirects to follow for a single request
exports.require_https = true; // Enforce https destinations when true
exports.allowed_content_type_regex = /^text\/calendar/i; // Allowed MIME type for calendar files
// Block internal or link-local addresses and metadata endpoints to prevent SSRF.
exports.blacklist_hostname_regex = /^(10\.|192\.168\.|127\.|0\.|169\.254\.|172\.(?:1[6-9]|2[0-9]|3[0-1])\.|100\.64\.|metadata\.)/i;

// Only allow well-known calendar providers (Google, Outlook/Office, iCloud, etc.).
// Matches any subdomain ending in one of these domains.
exports.allowed_calendar_hostname_regex = /(calendar\.google\.com|googleusercontent\.com|outlook\.live\.com|outlook\.office\.com|office\.com|office365\.com|icloud\.com)$/i;
exports.cluster_process_count = Number(process.env.CLUSTER_PROCESS_COUNT) || require("os").cpus().length;
exports.allowed_origin = "https://calign.mickzijdel.com";