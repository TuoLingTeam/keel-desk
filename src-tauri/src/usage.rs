//! 标题栏用量挂件的数据源。
//!
//! 两部分数据来自两个地方，因为官方 API 只提供余额，没有用量统计接口：
//!
//! * **余额**：`GET https://api.deepseek.com/user/balance`，凭据取自 Harness 自己的
//!   `~/.dsh/.credentials.yaml`，所以密钥不会出现在本仓库或应用包里。
//! * **今日用量**：从 `~/.dsh/sessions/**/session.jsonl.zstd` 里聚合。每次模型请求
//!   会先写一条 `request/header`（带 provider/model），随后写若干 `assistant/chunk`，
//!   其中 `chunk.type == "usage"` 那条带 token 明细。按当天 00:00 之后的时间戳过滤。
//!
//! 放在壳层而不是 Harness 插件里，是因为标题栏归壳层所有：WebView 里的 Harness 页面
//! 与壳层不同源，壳层 CSP 也只放行 IPC，跨源桥接反而更绕；而 Rust 侧既没有 CORS 限制，
//! 又能直接读会话日志。

use std::{
    collections::HashMap,
    fs::File,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;

/// 余额接口的超时；挂件是次要信息，不该让它拖住刷新循环。
const BALANCE_TIMEOUT: Duration = Duration::from_secs(12);
const BALANCE_ENDPOINT: &str = "https://api.deepseek.com/user/balance";

/// 一个账户币种下的余额明细，字段名对齐官方返回。
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Balance {
    pub currency: String,
    pub total: String,
    pub granted: String,
    pub topped_up: String,
    pub available: bool,
}

/// 今日按模型汇总的一行。
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub model: String,
    pub requests: u64,
    pub input_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_tokens: u64,
    /// 按单价表算出的金额；没有该模型单价时为 None，界面据此显示「—」而不是 0。
    pub cost: Option<f64>,
}

/// 今日整体用量。
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodayUsage {
    pub requests: u64,
    pub input_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_tokens: u64,
    /// 计费 token 合计（未命中输入 + 缓存读 + 缓存写 + 输出）。
    pub billed_tokens: u64,
    /// 缓存命中率，用 cacheRead / (cacheRead + input) 计。
    pub cache_hit_ratio: Option<f64>,
    pub cost: Option<f64>,
    pub by_model: Vec<ModelUsage>,
}

/// 挂件一次刷新拿到的全部内容。任一半失败都不影响另一半显示。
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub balance: Option<Balance>,
    pub balance_error: Option<String>,
    pub today: TodayUsage,
    pub usage_error: Option<String>,
    /// 生成时刻（毫秒），界面用它显示「x 秒前更新」。
    pub fetched_at: u64,
    /// 密钥是否已找到，供界面提示用户去配置。
    pub has_key: bool,
}

/// 每百万 token 单价（CNY）。缓存命中单独一档，比未命中便宜一个数量级。
#[derive(Clone, Copy, Debug)]
struct ModelPricing {
    input: f64,
    cache_read: f64,
    cache_write: f64,
    output: f64,
}

impl ModelPricing {
    /// 空闲价是高峰价的一半，官方就是这么定义的，所以只写高峰价再折半。
    const fn peak(input: f64, cache_read: f64, output: f64) -> Self {
        Self {
            input,
            cache_read,
            cache_write: input,
            output,
        }
    }

    fn halved(self) -> Self {
        Self {
            input: self.input / 2.0,
            cache_read: self.cache_read / 2.0,
            cache_write: self.cache_write / 2.0,
            output: self.output / 2.0,
        }
    }
}

/// 官方价目自 2026-08-17 起改为峰谷两档（元/百万 token），
/// 高峰为北京时间 09:00–12:00 与 14:00–18:00，空闲价为高峰价的一半。
fn peak_pricing_for(model: &str) -> Option<ModelPricing> {
    let id = model.to_ascii_lowercase();
    if id.contains("v4-pro") || id.contains("v4_pro") {
        return Some(ModelPricing::peak(9.0, 0.30, 27.0));
    }
    if id.contains("v4") || id.contains("flash") {
        return Some(ModelPricing::peak(3.0, 0.10, 9.0));
    }
    None
}

/// 北京时间（UTC+8）的小时数。计费时段按官方口径固定用北京时间，
/// 不跟随本机时区，否则出国用一次账就算错了。
fn beijing_hour(at_ms: u64) -> u64 {
    ((at_ms / 1000 + 8 * 3600) / 3600) % 24
}

fn is_peak(at_ms: u64) -> bool {
    let hour = beijing_hour(at_ms);
    (9..12).contains(&hour) || (14..18).contains(&hour)
}

/// 某个模型在某一时刻的适用单价。
fn pricing_at(model: &str, at_ms: u64) -> Option<ModelPricing> {
    let peak = peak_pricing_for(model)?;
    Some(if is_peak(at_ms) { peak } else { peak.halved() })
}

/// 读取 Harness 持久化的主题偏好（`~/.dsh/settings.yaml` 的 `ui-theme.preference`）。
///
/// 启动画面归壳层所有，但主题偏好归 Harness 所有，而 Harness 要等本地服务起来才能
/// 告知壳层。若此时先按系统主题绘制，深色用户就会看到一次白闪。因此这里在窗口出现
/// 之前直接读那份 YAML —— 这是同一个事实的最早可得来源。
pub fn boot_theme_preference() -> Option<String> {
    let text = std::fs::read_to_string(dsh_home().join("settings.yaml")).ok()?;
    let mut in_section = false;
    for line in text.lines() {
        let trimmed = line.trim_end();
        if !trimmed.starts_with([' ', '\t']) {
            // 顶层键：进入或离开 ui-theme 段。
            in_section = trimmed.trim_end_matches(':').trim() == "ui-theme";
            continue;
        }
        if !in_section {
            continue;
        }
        let Some((key, value)) = trimmed.split_once(':') else {
            continue;
        };
        if key.trim() != "preference" {
            continue;
        }
        let value = value.trim().trim_matches(['"', '\'']);
        if matches!(value, "dark" | "light" | "system") {
            return Some(value.to_string());
        }
    }
    None
}

fn dsh_home() -> PathBuf {
    if let Some(configured) = std::env::var_os("DSH_HOME") {
        let raw = configured.to_string_lossy().trim().to_string();
        if !raw.is_empty() && raw != "~" {
            let expanded = raw.strip_prefix("~/").map(|rest| home().join(rest));
            return expanded.unwrap_or_else(|| PathBuf::from(raw));
        }
    }
    home().join(".dsh")
}

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// 从 Harness 自己的凭据文件里取密钥，避免在本应用里再存一份。
fn read_api_key() -> Option<String> {
    let path = dsh_home().join(".credentials.yaml");
    let text = std::fs::read_to_string(path).ok()?;
    for line in text.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if key.trim() != "DEEPSEEK_API_KEY" {
            continue;
        }
        let value = value.trim().trim_matches(['"', '\'']).to_string();
        if !value.is_empty() {
            return Some(value);
        }
    }
    None
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 本地当天 00:00 的毫秒时间戳。用本地时区而非 UTC，才能和控制台（GMT+8）对得上。
fn local_midnight_ms() -> u64 {
    let now = now_ms();
    let offset_secs = local_utc_offset_secs();
    let local = now as i64 + offset_secs * 1000;
    let day = local - local.rem_euclid(86_400_000);
    (day - offset_secs * 1000).max(0) as u64
}

/// 通过比较本地时间与 UTC 的日历差推出时区偏移，避免引入 chrono 依赖。
fn local_utc_offset_secs() -> i64 {
    // `date +%z` 是 POSIX 下最省事且始终正确（含夏令时）的取法。
    let output = std::process::Command::new("date").arg("+%z").output().ok();
    let Some(output) = output else { return 0 };
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.len() < 5 {
        return 0;
    }
    let sign = if text.starts_with('-') { -1 } else { 1 };
    let digits = &text[1..];
    let hours: i64 = digits[0..2].parse().unwrap_or(0);
    let minutes: i64 = digits[2..4].parse().unwrap_or(0);
    sign * (hours * 3600 + minutes * 60)
}

fn balance_string(value: &serde_json::Value, key: &str) -> String {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("0")
        .to_string()
}

/// 拉取账户余额。
fn fetch_balance(api_key: &str) -> Result<Balance, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(BALANCE_TIMEOUT)
        .build()
        .map_err(|error| format!("创建 HTTP 客户端失败：{error}"))?;
    let response = client
        .get(BALANCE_ENDPOINT)
        .bearer_auth(api_key)
        .send()
        .map_err(|error| format!("请求余额接口失败：{error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("余额接口返回 {status}"));
    }
    let body: serde_json::Value = response
        .json()
        .map_err(|error| format!("解析余额响应失败：{error}"))?;
    let available = body
        .get("is_available")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let info = body
        .get("balance_infos")
        .and_then(|v| v.as_array())
        .and_then(|rows| rows.first())
        .ok_or_else(|| "余额响应里没有 balance_infos".to_string())?;
    Ok(Balance {
        currency: info
            .get("currency")
            .and_then(|v| v.as_str())
            .unwrap_or("CNY")
            .to_string(),
        total: balance_string(info, "total_balance"),
        granted: balance_string(info, "granted_balance"),
        topped_up: balance_string(info, "topped_up_balance"),
        available,
    })
}

/// 累加一条 usage 事件，并按这条请求**发生时刻**的档位计价——
/// 峰谷价一天内会切换四次，用当日总量乘一个单价会算错。
fn add_usage(row: &mut ModelUsage, usage: &serde_json::Value, at_ms: u64) {
    let field = |name: &str| usage.get(name).and_then(serde_json::Value::as_u64).unwrap_or(0);
    let input = field("inputTokens");
    let output = field("outputTokens");
    let cache_read = field("cacheReadTokens");
    let cache_write = field("cacheWriteTokens");

    row.requests += 1;
    row.input_tokens += input;
    row.output_tokens += output;
    row.cache_read_tokens += cache_read;
    row.cache_write_tokens += cache_write;
    row.reasoning_tokens += field("reasoningTokens");

    if let Some(price) = pricing_at(&row.model, at_ms) {
        let spend = (input as f64 * price.input
            + cache_read as f64 * price.cache_read
            + cache_write as f64 * price.cache_write
            + output as f64 * price.output)
            / 1_000_000.0;
        row.cost = Some(row.cost.unwrap_or(0.0) + spend);
    }
}

/// 扫描一个会话日志，把当天的用量并进结果表。
fn scan_session(path: &Path, since_ms: u64, totals: &mut HashMap<String, ModelUsage>) {
    let Ok(file) = File::open(path) else { return };
    let Ok(decoder) = zstd::stream::read::Decoder::new(file) else {
        return;
    };
    let mut model = String::from("(unknown)");
    for line in BufReader::new(decoder).lines() {
        let Ok(line) = line else { return };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(record) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        match record.get("type").and_then(|v| v.as_str()) {
            // 请求头先于它的用量事件写入，所以顺序扫描就能把用量归到正确的模型。
            Some("request/header") => {
                if let Some(id) = record
                    .pointer("/data/header/config/model")
                    .and_then(|v| v.as_str())
                {
                    model = id.to_string();
                }
            }
            Some("assistant/chunk") => {
                let chunk = record.pointer("/data/chunk");
                let is_usage = chunk
                    .and_then(|c| c.get("type"))
                    .and_then(|v| v.as_str())
                    .is_some_and(|t| t == "usage");
                if !is_usage {
                    continue;
                }
                let time = record.get("time").and_then(serde_json::Value::as_u64).unwrap_or(0);
                if time < since_ms {
                    continue;
                }
                let Some(usage) = chunk.and_then(|c| c.get("usage")) else {
                    continue;
                };
                let row = totals.entry(model.clone()).or_insert_with(|| ModelUsage {
                    model: model.clone(),
                    ..ModelUsage::default()
                });
                add_usage(row, usage, time);
            }
            _ => {}
        }
    }
}

/// 收集今天的会话日志文件。按 mtime 过滤，今天没写过的会话不必解压。
fn todays_session_logs(since_ms: u64) -> Vec<PathBuf> {
    let root = dsh_home().join("sessions");
    let mut logs = Vec::new();
    let Ok(workspaces) = std::fs::read_dir(&root) else {
        return logs;
    };
    for workspace in workspaces.flatten() {
        let Ok(sessions) = std::fs::read_dir(workspace.path()) else {
            continue;
        };
        for session in sessions.flatten() {
            let candidate = session.path().join("session.jsonl.zstd");
            let touched = candidate
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            if touched >= since_ms {
                logs.push(candidate);
            }
        }
    }
    logs
}

/// 统计今日用量。
fn collect_today() -> TodayUsage {
    let since = local_midnight_ms();
    let mut totals: HashMap<String, ModelUsage> = HashMap::new();
    for log in todays_session_logs(since) {
        scan_session(&log, since, &mut totals);
    }

    let mut today = TodayUsage::default();
    let mut by_model: Vec<ModelUsage> = totals.into_values().collect();
    for row in &mut by_model {
        today.requests += row.requests;
        today.input_tokens += row.input_tokens;
        today.cache_read_tokens += row.cache_read_tokens;
        today.cache_write_tokens += row.cache_write_tokens;
        today.output_tokens += row.output_tokens;
        today.reasoning_tokens += row.reasoning_tokens;
        if let Some(cost) = row.cost {
            today.cost = Some(today.cost.unwrap_or(0.0) + cost);
        }
    }
    by_model.sort_by(|a, b| b.requests.cmp(&a.requests));

    today.billed_tokens = today.input_tokens
        + today.cache_read_tokens
        + today.cache_write_tokens
        + today.output_tokens;
    let prompt = today.input_tokens + today.cache_read_tokens;
    if prompt > 0 {
        today.cache_hit_ratio = Some(today.cache_read_tokens as f64 / prompt as f64);
    }
    today.by_model = by_model;
    today
}

/// 采一次完整快照。余额与用量互不阻塞：一边失败仍返回另一边。
pub fn snapshot() -> UsageSnapshot {
    let key = read_api_key();
    let mut snapshot = UsageSnapshot {
        has_key: key.is_some(),
        fetched_at: now_ms(),
        ..UsageSnapshot::default()
    };
    match key {
        Some(key) => match fetch_balance(&key) {
            Ok(balance) => snapshot.balance = Some(balance),
            Err(error) => snapshot.balance_error = Some(error),
        },
        None => {
            snapshot.balance_error =
                Some("未在 ~/.dsh/.credentials.yaml 找到 DEEPSEEK_API_KEY".into());
        }
    }
    snapshot.today = collect_today();
    snapshot
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 北京时间某天某点的毫秒时间戳。
    fn at_beijing(hour: u64) -> u64 {
        // 2026-08-20 00:00 UTC 起算，再减去 8 小时时差换成北京时间的当天钟点。
        let day_utc = 1_787_184_000_000_u64;
        day_utc + hour * 3_600_000 - 8 * 3_600_000
    }

    #[test]
    fn prices_the_deepseek_family_and_leaves_others_unpriced() {
        assert!(peak_pricing_for("deepseek-v4-flash").is_some());
        assert!(peak_pricing_for("deepseek-v4-pro").is_some());
        assert!(peak_pricing_for("some-other-vendor-model").is_none());
    }

    #[test]
    fn pro_costs_more_than_flash_on_every_tier() {
        let flash = peak_pricing_for("deepseek-v4-flash").expect("flash");
        let pro = peak_pricing_for("deepseek-v4-pro").expect("pro");
        assert!(pro.input > flash.input);
        assert!(pro.cache_read > flash.cache_read);
        assert!(pro.output > flash.output);
    }

    #[test]
    fn cache_reads_are_an_order_of_magnitude_cheaper_than_misses() {
        let price = peak_pricing_for("deepseek-v4-flash").expect("pricing");
        assert!(price.cache_read * 10.0 < price.input);
    }

    #[test]
    fn peak_window_follows_beijing_business_hours() {
        assert!(!is_peak(at_beijing(3)));
        assert!(is_peak(at_beijing(9)));
        assert!(is_peak(at_beijing(11)));
        assert!(!is_peak(at_beijing(12)));
        assert!(!is_peak(at_beijing(13)));
        assert!(is_peak(at_beijing(14)));
        assert!(is_peak(at_beijing(17)));
        assert!(!is_peak(at_beijing(18)));
        assert!(!is_peak(at_beijing(23)));
    }

    #[test]
    fn off_peak_costs_exactly_half_of_peak() {
        let mut peak_row = ModelUsage {
            model: "deepseek-v4-flash".into(),
            ..ModelUsage::default()
        };
        let mut quiet_row = peak_row.clone();
        let usage = serde_json::json!({ "inputTokens": 1_000_000, "outputTokens": 0 });
        add_usage(&mut peak_row, &usage, at_beijing(10));
        add_usage(&mut quiet_row, &usage, at_beijing(3));
        let peak = peak_row.cost.expect("peak cost");
        let quiet = quiet_row.cost.expect("off-peak cost");
        assert!((peak - 3.0).abs() < 1e-9, "peak miss price is 3.0/M, got {peak}");
        assert!((quiet - peak / 2.0).abs() < 1e-9);
    }

    #[test]
    fn totals_bill_every_token_class_but_not_reasoning() {
        // reasoning tokens are already counted inside output on this route, so
        // adding them again would double-bill the thinking budget.
        let mut row = ModelUsage {
            model: "deepseek-v4-flash".into(),
            ..ModelUsage::default()
        };
        let usage = serde_json::json!({
            "inputTokens": 10,
            "outputTokens": 4,
            "cacheReadTokens": 100,
            "reasoningTokens": 3,
        });
        add_usage(&mut row, &usage, at_beijing(3));
        assert_eq!(row.requests, 1);
        assert_eq!(row.input_tokens, 10);
        assert_eq!(row.cache_read_tokens, 100);
        assert_eq!(row.reasoning_tokens, 3);
        // 空闲价：10*1.5 + 100*0.05 + 4*4.5 元每百万。
        let expected = (10.0 * 1.5 + 100.0 * 0.05 + 4.0 * 4.5) / 1_000_000.0;
        assert!((row.cost.expect("cost") - expected).abs() < 1e-12);
    }

    /// 只读诊断：对着本机真实会话日志跑一遍统计，用来核对数字。
    /// 默认不参与 CI，用 `cargo test -- --ignored --nocapture usage` 手动执行。
    #[test]
    #[ignore = "reads the developer's own session logs"]
    fn prints_todays_real_usage() {
        let today = collect_today();
        println!("today: requests={} billed={}", today.requests, today.billed_tokens);
        println!(
            "  input={} cacheRead={} output={} hit={:?} cost={:?}",
            today.input_tokens,
            today.cache_read_tokens,
            today.output_tokens,
            today.cache_hit_ratio,
            today.cost
        );
        for row in &today.by_model {
            println!("  {} -> {} 次, cost={:?}", row.model, row.requests, row.cost);
        }
    }

    #[test]
    fn local_midnight_is_at_a_day_boundary_in_local_time() {
        let midnight = local_midnight_ms();
        let offset = local_utc_offset_secs() * 1000;
        assert_eq!((midnight as i64 + offset).rem_euclid(86_400_000), 0);
        assert!(midnight <= now_ms());
    }
}
