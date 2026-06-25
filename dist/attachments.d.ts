export declare const MAX_IMAGE_DIM = 1280;
export declare const MAX_TEXT_BYTES: number;
export interface ImageAttachment {
    id: string;
    kind: 'image';
    name: string;
    dataUrl: string;
    w: number;
    h: number;
}
export interface FileAttachment {
    id: string;
    kind: 'file';
    name: string;
    text: string;
    truncated?: boolean;
}
export type Attachment = ImageAttachment | FileAttachment;
export declare function isTextLike(file: File): boolean;
export interface AttachResult {
    att?: Attachment;
    error?: string;
}
export declare function fileToAttachment(file: File): Promise<AttachResult>;
type ContentPart = {
    type: 'text';
    text: string;
} | {
    type: 'image_url';
    image_url: {
        url: string;
    };
};
export declare function toApiContent(content: string, attachments?: Attachment[]): string | ContentPart[];
export {};
