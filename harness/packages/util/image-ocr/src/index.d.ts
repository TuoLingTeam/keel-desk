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
import { type NativeCommandRunner } from '@deepseek-ai/dsh-native-command';
/** Which engine produced a recognition. */
export type OcrEngine = 'vision' | 'tesseract';
/** Why an image yielded no readable text, when it yielded none. */
export type OcrRefusal = 'empty' | 'too-large' | 'unavailable';
/** The result of one recognition attempt. */
export type OcrOutcome = {
    kind: 'text';
    /** Engine that produced the text. */
    engine: OcrEngine;
    /** Recognised text, already trimmed and never empty. */
    text: string;
    /** Whether this came from the digest cache rather than a fresh run. */
    cached: boolean;
} | {
    kind: OcrRefusal;
    /** Human-readable reason, safe to hand to a model. */
    detail: string;
};
/** Everything the recogniser needs about one image. */
export interface OcrRequest {
    /** Encoded image bytes (png/jpeg/webp/gif). */
    data: Uint8Array;
    /** Verified media type; only its subtype is used, for the temp file suffix. */
    mediaType: string;
    /** Caller lifetime; abort terminates the helper process. */
    signal?: AbortSignal;
}
/** Construction-time knobs; every one has a working default. */
export interface OcrOptions {
    /**
     * Largest image to attempt, in bytes. Recognition cost grows with pixel
     * count and a huge screenshot is rarely worth the stall.
     */
    maxBytes?: number;
    /** macOS Vision helper, resolved on PATH unless an absolute path is given. */
    visionCommand?: string;
    /** Tesseract executable, resolved on PATH unless an absolute path is given. */
    tesseractCommand?: string;
    /** Tesseract language packs, in its own `+`-joined syntax. */
    tesseractLanguages?: string;
    /** How many digests to remember. */
    cacheSize?: number;
    /** Command boundary seam; tests substitute a fake runner. */
    run?: NativeCommandRunner;
}
/** The recognition face shared by the serializer and the `read_image` tool. */
export interface ImageOcr {
    /**
     * Recognise the text in one image.
     * @param request - image bytes, media type, and caller lifetime.
     * @returns the recognised text, or why there is none.
     */
    recognize(request: OcrRequest): Promise<OcrOutcome>;
}
/** Default ceiling: past this an image is described rather than recognised. */
export declare const DEFAULT_MAX_BYTES: number;
/** Default digest cache capacity. */
export declare const DEFAULT_CACHE_SIZE = 64;
/**
 * Build a recogniser over the configured engines.
 * @param options - engine paths, limits, and the command seam.
 * @returns a recogniser whose results are memoised on content digest.
 */
export declare function createImageOcr(options?: OcrOptions): ImageOcr;
/**
 * Render one outcome as the text block a model receives in place of an image.
 * Every branch says something explicit, so an unreadable image is never
 * silently dropped from the conversation.
 * @param outcome - the recognition result.
 * @param label - optional file name or path to name the image by.
 * @returns model-facing text.
 */
export declare function describeImageForModel(outcome: OcrOutcome, label?: string): string;
//# sourceMappingURL=index.d.ts.map