import * as FileSystem from "expo-file-system/legacy";
import { Platform } from "react-native";

import { signMediaPaths } from "@/lib/media-url";
import { supabase } from "@/lib/supabase";
import { validateStorageUpload } from "@/lib/storage-paths";

/**
 * Nahrávání binárek do media store (Cloudflare R2).
 *
 * Dřív šlo všechno do Supabase Storage - a ten má na free planu 1 GB.
 * Teď:
 * 1) edge funkce vystaví podepsanou PUT URL (`upload_intent`) a zkontroluje
 *    rozpočet uživatele,
 * 2) klient posílá soubor PŘÍMO do R2 (data nejdou přes Supabase),
 * 3) `register` zapíše soubor do katalogu `sc_media_objects`.
 */

export type MediaFolder = "covers" | "audio" | "videos" | "media";

export type MediaUploadResult = {
  key: string;
  url: string;
  byteSize: number;
  originalFileName: string;
  mimeType: string;
};

const SIGN_FUNCTION = "songcraft-media-store";

const kindForFolder = (folder: MediaFolder) => folder === "covers" ? "cover" : folder === "audio" ? "audio" : folder === "media" ? "media" : "video";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return globalThis.btoa(binary);
}

async function putToR2(uploadUrl: string, bytes: Uint8Array, contentType: string, sourceUri?: string | null): Promise<void> {
  if (Platform.OS !== "web" && sourceUri) {
    // Na nativu je fetch s binárním tělem nespolehlivý - uploadAsync to umí.
    const result = await FileSystem.uploadAsync(uploadUrl, sourceUri, {
      httpMethod: "PUT",
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      headers: { "Content-Type": contentType },
    });
    const status = result.status;
    if (status < 200 || status >= 300) throw new Error(`Nahrávání do media store selhalo (HTTP ${status}).`);
    return;
  }

  if (Platform.OS === "web") {
    const response = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": contentType }, body: new Blob([new Uint8Array(bytes).buffer as ArrayBuffer], { type: contentType }) });
    if (!response.ok) throw new Error(`Nahrávání do media store selhalo (HTTP ${response.status}).`);
    return;
  }

  throw new Error("Nahrávání bez zdrojového souboru není na tomto zařízení podporované.");
}

export async function uploadMedia(input: {
  folder: MediaFolder;
  fileName: string;
  contentType: string;
  bytes: ArrayBuffer;
  base64?: string | null;
  sourceUri?: string | null;
}): Promise<MediaUploadResult> {
  const bytes = input.bytes ? new Uint8Array(input.bytes) : null;
  if (!bytes || bytes.byteLength === 0) throw new Error("Chybí data souboru pro nahrání.");

  const validated = validateStorageUpload({ folder: input.folder === "media" ? "covers" : input.folder, contentType: input.contentType, fileName: input.fileName, bytes });

  const { data: intent, error: intentError } = await supabase.functions.invoke(SIGN_FUNCTION, {
    body: {
      action: "upload_intent",
      folder: input.folder,
      fileName: validated.fileName,
      contentType: validated.mimeType,
      byteSize: bytes.byteLength,
    },
  });
  if (intentError || !intent) throw new Error(intentError?.message || "Media store není dostupný.");

  const { key, uploadUrl, contentType } = intent as { key: string; uploadUrl: string; contentType: string };

  let uploaded = false;
  if (uploadUrl) {
    try {
      await putToR2(uploadUrl, bytes, contentType, input.sourceUri);
      uploaded = true;
    } catch (error) {
      if (input.base64) throw error;
      // Fallback: soubor pošleme přes edge funkci (menší soubory, web).
      const fallback = await supabase.functions.invoke(SIGN_FUNCTION, {
        body: {
          action: "upload",
          folder: input.folder,
          fileName: validated.fileName,
          contentType: validated.mimeType,
          base64: input.base64 ?? bytesToBase64(bytes),
        },
      });
      if (fallback.error || !fallback.data) throw new Error(fallback.error?.message || "Nahrávání se nezdařilo.");
      const result = fallback.data as { key: string; url: string | null; byteSize: number; contentType: string };
      await supabase.functions.invoke(SIGN_FUNCTION, {
        body: { action: "register", storagePath: result.key, byteSize: result.byteSize, kind: kindForFolder(input.folder) },
      });
      const urls = await signMediaPaths([result.key]);
      return { key: result.key, url: urls[result.key] ?? result.url ?? "", byteSize: result.byteSize, originalFileName: validated.fileName, mimeType: result.contentType };
    }
  }

  if (!uploaded) throw new Error("Nahrávání se nezdařilo.");

  const { error: registerError } = await supabase.functions.invoke(SIGN_FUNCTION, {
    body: { action: "register", storagePath: key, byteSize: bytes.byteLength, kind: kindForFolder(input.folder) },
  });
  if (registerError) throw new Error(registerError.message);

  const urls = await signMediaPaths([key]);
  return { key, url: urls[key] ?? "", byteSize: bytes.byteLength, originalFileName: validated.fileName, mimeType: contentType };
}
