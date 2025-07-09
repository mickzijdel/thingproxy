var http = require('http');
var https = require('https');
var dns = require('dns');
var net = require('net');
var config = require("./config");
var url = require("url");
var request = require("request");
var cluster = require('cluster');
var throttle = require("tokenthrottle")({rate: config.max_requests_per_second});

http.globalAgent.maxSockets = Infinity;
https.globalAgent.maxSockets = Infinity;

var publicAddressFinder = require("public-address");
var publicIP;

// Get our public IP address
publicAddressFinder(function (err, data) {
    if (!err && data) {
        publicIP = data.address;
    }
});

function addCORSHeaders(req, res) {
    if (req.method.toUpperCase() === "OPTIONS") {
        if (req.headers["access-control-request-headers"]) {
            res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"]);
        }

        if (req.headers["access-control-request-method"]) {
            res.setHeader("Access-Control-Allow-Methods", req.headers["access-control-request-method"]);
        }
    }

    if (req.headers["origin"]) {
        res.setHeader("Access-Control-Allow-Origin", req.headers["origin"]);
    }
    else {
        res.setHeader("Access-Control-Allow-Origin", "*");
    }
}

function writeResponse(res, httpCode, body) {
    res.statusCode = httpCode;
    res.end(body);
}

function sendInvalidURLResponse(res) {
    return writeResponse(res, 404, "url must be in the form of /fetch/{some_url_here}");
}

function sendTooBigResponse(res) {
    return writeResponse(res, 413, "the content in the request or response cannot exceed " + config.max_request_length + " characters.");
}

function getClientAddress(req) {
    return (req.headers['x-forwarded-for'] || '').split(',')[0]
        || req.connection.remoteAddress;
}

function isPrivateIP(ip) {
    if (!ip) return true;
    if (net.isIP(ip) === 4) {
        var p = ip.split('.').map(Number);
        if (p[0] === 10) return true;
        if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
        if (p[0] === 192 && p[1] === 168) return true;
        if (p[0] === 127) return true;
        if (p[0] === 169 && p[1] === 254) return true;
        if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
        if (p[0] === 0) return true;
    } else if (net.isIP(ip) === 6) {
        var lower = ip.toLowerCase();
        if (lower === '::1') return true; // loopback
        if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
        if (lower.startsWith('fe80')) return true; // link-local
    }
    return false;
}

function processRequest(req, res) {
    addCORSHeaders(req, res);

    // Return options pre-flight requests right away
    if (req.method.toUpperCase() === "OPTIONS") {
        return writeResponse(res, 204);
    }

    // Only allow safe read-only methods
    if (req.method !== "GET" && req.method !== "HEAD") {
        return writeResponse(res, 405, "method not allowed");
    }

    var result = config.fetch_regex.exec(req.url);

    if (result && result.length == 2 && result[1]) {
        var remoteURL;

        try {
            remoteURL = url.parse(decodeURI(result[1]));
        }
        catch (e) {
            return sendInvalidURLResponse(res);
        }

        // We don't support relative links
        if (!remoteURL.host) {
            return writeResponse(res, 404, "relative URLS are not supported");
        }

        // Naughty, naughty— deny requests to blacklisted hosts
        if (config.blacklist_hostname_regex.test(remoteURL.hostname)) {
            return writeResponse(res, 400, "naughty, naughty...");
        }

        // We only support http and https
        if (remoteURL.protocol != "http:" && remoteURL.protocol !== "https:") {
            return writeResponse(res, 400, "only http and https are supported");
        }

        // Only proxy requests for .ics files
        if (!remoteURL.pathname || !remoteURL.pathname.toLowerCase().endsWith(".ics")) {
            return writeResponse(res, 400, "only .ics files are supported");
        }

        // Allow only specific calendar hostnames (Google, Outlook, iCloud, etc.)
        if (!config.allowed_calendar_hostname_regex.test(remoteURL.hostname)) {
            return writeResponse(res, 400, "calendar host not supported");
        }

        if (publicIP) {
            // Add an X-Forwarded-For header
            if (req.headers["x-forwarded-for"]) {
                req.headers["x-forwarded-for"] += ", " + publicIP;
            }
            else {
                req.headers["x-forwarded-for"] = req.clientIP + ", " + publicIP;
            }
        }

        // Make sure the host header is to the URL we're requesting, not thingproxy
        if (req.headers["host"]) {
            req.headers["host"] = remoteURL.host;
        }
        
        // Remove origin and referer headers. TODO: This is a bit naughty, we should remove at some point.
        delete req.headers["origin"];
        delete req.headers["referer"];

        // Strip cookies or auth headers that could leak user context
        delete req.headers["cookie"];
        delete req.headers["authorization"];

        var proxyRequest = request({
            url: remoteURL,
            headers: req.headers,
            method: req.method,
            lookup: function(hostname, options, callback) {
                dns.lookup(hostname, options, function(err, address, family) {
                    if (err) {
                        return callback(err);
                    }
                    if (isPrivateIP(address)) {
                        return callback(new Error("Address not allowed"));
                    }
                    callback(null, address, family);
                });
            },
            maxRedirects: config.max_redirects,
            timeout: config.proxy_request_timeout_ms,
            strictSSL: false
        });

        // Re-validate every redirect target to ensure it stays within policy
        proxyRequest.on('redirect', function (response, nextOptions) {
            try {
                var redirectTarget = url.parse(nextOptions.href || response.headers.location || "");

                // Basic sanity: must have host and https/http
                if (!redirectTarget.host || (redirectTarget.protocol !== "http:" && redirectTarget.protocol !== "https:")) {
                    proxyRequest.abort();
                    return writeResponse(res, 400, "redirect blocked");
                }

                // Apply the same hostname and path validations as original
                if (config.blacklist_hostname_regex.test(redirectTarget.hostname) ||
                    !config.allowed_calendar_hostname_regex.test(redirectTarget.hostname) ||
                    !redirectTarget.pathname || !redirectTarget.pathname.toLowerCase().endsWith(".ics")) {
                    proxyRequest.abort();
                    return writeResponse(res, 400, "redirect blocked");
                }

            } catch (e) {
                proxyRequest.abort();
                return writeResponse(res, 400, "redirect blocked");
            }
        });

        proxyRequest.on('error', function (err) {

            if (err.code === "ENOTFOUND") {
                return writeResponse(res, 502, "Host for " + url.format(remoteURL) + " cannot be found.")
            }
            else {
                console.log("Proxy Request Error (" + url.format(remoteURL) + "): " + err.toString());
                return writeResponse(res, 500);
            }

        });

        var requestSize = 0;
        var proxyResponseSize = 0;

        req.pipe(proxyRequest).on('data', function (data) {

            requestSize += data.length;

            if (requestSize >= config.max_request_length) {
                proxyRequest.end();
                return sendTooBigResponse(res);
            }
        }).on('error', function(err){
            writeResponse(res, 500, "Stream Error");
        });

        proxyRequest.pipe(res).on('data', function (data) {

            proxyResponseSize += data.length;

            if (proxyResponseSize >= config.max_request_length) {
                proxyRequest.end();
                return sendTooBigResponse(res);
            }
        }).on('error', function(err){
            writeResponse(res, 500, "Stream Error");
        });
    }
    else {
        return sendInvalidURLResponse(res);
    }
}

if (cluster.isMaster) {
    for (var i = 0; i < config.cluster_process_count; i++) {
        cluster.fork();
    }
}
else
{
    http.createServer(function (req, res) {

        // Process health checks (/health and /up endpoints)
        if (req.url === "/health" || req.url === "/up") {
            return writeResponse(res, 200);
        }

        var clientIP = getClientAddress(req);

        req.clientIP = clientIP;

        // Log our request
        if (config.enable_logging) {
            console.log("%s %s %s", (new Date()).toJSON(), clientIP, req.method, req.url);
        }

        if (config.enable_rate_limiting) {
            throttle.rateLimit(clientIP, function (err, limited) {
                if (limited) {
                    return writeResponse(res, 429, "enhance your calm");
                }

                processRequest(req, res);
            })
        }
        else {
            processRequest(req, res);
        }

    }).listen(config.port);

    console.log("thingproxy.freeboard.io process started (PID " + process.pid + ")");
}
