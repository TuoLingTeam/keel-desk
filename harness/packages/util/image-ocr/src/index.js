/**
 * Shared offline image-to-text recognition for routes that must accept images
 * without a vision-capable model: the DeepSeek chat-completions serializer and
 * the `read_image` tool both fold an image into readable text through here, so
 * a model that cannot see an image still receives what it says.
 *
 * macOS Vision (the `dsh-ocr` helper) is preferred because it is local, needs
 * no network, and handles mixed Chinese/English well; tesseract is the
 * fallback. Results are memoised on the image's content digest, so the same
 * picture reappearing in conversation history costs one recognition, not one
 * per request. A library, not a plugin — no ctx, no state beyond that cache.
 * @module @deepseek-ai/dsh-image-ocr
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNativeCommand } from '@deepseek-ai/dsh-native-command';
/** Default ceiling: past this an image is described rather than recognised. */
export const DEFAULT_MAX_BYTES = 12 * 1024 * 1024;
/** Default digest cache capacity. */
export const DEFAULT_CACHE_SIZE = 64;
const DEFAULT_VISION_COMMAND = 'dsh-ocr';
const DEFAULT_TESSERACT_COMMAND = 'tesseract';
const DEFAULT_TESSERACT_LANGUAGES = 'chi_sim+eng';
/**
 * GUI 应用继承的 PATH 往往不含包管理器目录：macOS 从 Dock 启动只有
 * `/usr/bin:/bin:/usr/sbin:/sbin`，Windows 的服务/快捷方式同样可能缺少
 * 安装目录。只靠 PATH 会让应用误判成「没装 OCR」，而终端里明明跑得好好的。
 * 所以裸命令名要逐个候选目录去找，候选表按平台给。
 */
const WINDOWS = process.platform === 'win32';
const UNIX_SEARCH_DIRS = [
    '/opt/homebrew/bin', // Apple 芯片 Homebrew
    '/usr/local/bin', // Intel Homebrew、手工安装
    '/opt/local/bin', // MacPorts
    '/home/linuxbrew/.linuxbrew/bin', // Linuxbrew
    '/usr/bin',
    '/bin',
];
/** Windows 上 tesseract 的常见安装位置；环境变量缺失时用字面回退。 */
function windowsSearchDirs() {
    const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const localAppData = process.env['LOCALAPPDATA'];
    return [
        `${programFiles}\\Tesseract-OCR`,
        `${programFilesX86}\\Tesseract-OCR`,
        ...(localAppData === undefined ? [] : [`${localAppData}\\Programs\\Tesseract-OCR`]),
    ];
}
/**
 * 把一个命令展开成按优先级排列的候选路径；已含路径分隔符的原样返回。
 * Windows 还要补 `.exe`，否则 execFile 找不到。
 */
function commandCandidates(command) {
    if (command.includes('/') || command.includes('\\'))
        return [command];
    if (WINDOWS) {
        const exe = command.endsWith('.exe') ? command : `${command}.exe`;
        return [...windowsSearchDirs().map(dir => `${dir}\\${exe}`), exe, command];
    }
    return [...UNIX_SEARCH_DIRS.map(dir => `${dir}/${command}`), command];
}
const SUFFIX_BY_SUBTYPE = {
    png: '.png',
    jpeg: '.jpg',
    webp: '.webp',
    gif: '.gif',
};
/** Temp-file suffix for a media type; unknown types keep a neutral one. */
function suffixFor(mediaType) {
    const subtype = mediaType.split('/')[1]?.toLowerCase() ?? '';
    return SUFFIX_BY_SUBTYPE[subtype] ?? '.img';
}
/** Collapse a helper failure into one line worth showing a model. */
function reasonOf(error) {
    if (error instanceof Error) {
        const code = error.code;
        if (code === 'ENOENT')
            return 'not installed';
        if (typeof code === 'string' && code.length > 0)
            return code;
        return error.message.split('\n')[0] ?? 'failed';
    }
    return 'failed';
}
/**
 * Build a recogniser over the configured engines.
 * @param options - engine paths, limits, and the command seam.
 * @returns a recogniser whose results are memoised on content digest.
 */
export function createImageOcr(options = {}) {
    const { maxBytes = DEFAULT_MAX_BYTES, visionCommand = DEFAULT_VISION_COMMAND, tesseractCommand = DEFAULT_TESSERACT_COMMAND, tesseractLanguages = DEFAULT_TESSERACT_LANGUAGES, cacheSize = DEFAULT_CACHE_SIZE, run = runNativeCommand, } = options;
    // Insertion-ordered digest cache. A Map iterates in insertion order, so the
    // oldest key is the first one and eviction needs no bookkeeping.
    const cache = new Map();
    // In-flight de-duplication: history replays can ask for the same image
    // several times before the first recognition has returned.
    const pending = new Map();
    // 每个引擎一旦解析出可用的绝对路径就固定下来。
    const resolved = new Map();
    const remember = (digest, outcome) => {
        cache.set(digest, outcome);
        if (cache.size > cacheSize) {
            const oldest = cache.keys().next();
            if (!oldest.done)
                cache.delete(oldest.value);
        }
        return outcome;
    };
    const runEngines = async (request) => {
        const signal = request.signal ?? new AbortController().signal;
        const directory = await mkdtemp(join(tmpdir(), 'dsh-ocr-'));
        const file = join(directory, `image${suffixFor(request.mediaType)}`);
        try {
            await writeFile(file, request.data);
            // Vision 走的是 macOS 系统框架，其它平台上它不可能存在，试它只会
            // 拖慢每次识别、并在错误信息里留下误导性的「vision: not installed」。
            const attempts = [
                ...(process.platform === 'darwin'
                    ? [{ engine: 'vision', command: visionCommand, argv: [file] }]
                    : []),
                {
                    engine: 'tesseract',
                    command: tesseractCommand,
                    argv: [file, 'stdout', '-l', tesseractLanguages],
                },
            ];
            const failures = [];
            for (const attempt of attempts) {
                // 记住上次命中的绝对路径，后续调用不必再逐个目录试。
                const candidates = resolved.get(attempt.engine) ?? commandCandidates(attempt.command);
                let lastReason = 'not installed';
                for (const candidate of candidates) {
                    try {
                        const { stdout } = await run(candidate, attempt.argv, signal);
                        resolved.set(attempt.engine, [candidate]);
                        const text = stdout.trim();
                        if (text.length === 0) {
                            return { kind: 'empty', detail: `${attempt.engine} found no text in this image` };
                        }
                        return { kind: 'text', engine: attempt.engine, text, cached: false };
                    }
                    catch (error) {
                        if (signal.aborted)
                            throw error;
                        const reason = reasonOf(error);
                        // 找不到这个候选就换下一个；引擎真的报错则不必再试其它路径。
                        if (reason !== 'not installed') {
                            lastReason = reason;
                            break;
                        }
                        lastReason = reason;
                    }
                }
                failures.push(`${attempt.engine}: ${lastReason}`);
            }
            return { kind: 'unavailable', detail: `no OCR engine succeeded (${failures.join('; ')})` };
        }
        finally {
            await rm(directory, { recursive: true, force: true });
        }
    };
    return {
        async recognize(request) {
            if (request.data.byteLength > maxBytes) {
                return {
                    kind: 'too-large',
                    detail: `image is ${request.data.byteLength} bytes, over the ${maxBytes}-byte OCR limit`,
                };
            }
            const digest = createHash('sha256').update(request.data).digest('hex');
            const hit = cache.get(digest);
            if (hit !== undefined) {
                return hit.kind === 'text' ? { ...hit, cached: true } : hit;
            }
            const inFlight = pending.get(digest);
            if (inFlight !== undefined)
                return await inFlight;
            const attempt = runEngines(request)
                .then(outcome => remember(digest, outcome))
                .finally(() => { pending.delete(digest); });
            pending.set(digest, attempt);
            return await attempt;
        },
    };
}
/**
 * Render one outcome as the text block a model receives in place of an image.
 * Every branch says something explicit, so an unreadable image is never
 * silently dropped from the conversation.
 * @param outcome - the recognition result.
 * @param label - optional file name or path to name the image by.
 * @returns model-facing text.
 */
export function describeImageForModel(outcome, label) {
    const named = label === undefined ? 'image' : `image "${label}"`;
    if (outcome.kind === 'text') {
        return `[${named}, text recognised by OCR (${outcome.engine})]\n${outcome.text}`;
    }
    return `[${named}: ${outcome.detail}]`;
}
//# sourceMappingURL=index.js.map