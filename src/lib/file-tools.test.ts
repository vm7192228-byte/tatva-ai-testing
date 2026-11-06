import { vi } from "vitest";





async function findZipCentralEntry(blob: Blob, wantedPath: string) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lowerBound = Math.max(0, bytes.length - 65_557);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= lowerBound; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50 &&
        offset + 22 + view.getUint16(offset + 20, true) === bytes.length) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error("Test ZIP has no end-of-directory record.");
  const count = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error("Test ZIP has an invalid central directory.");
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    if (name === wantedPath) return { bytes, view, cursor };
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error("Test ZIP entry not found: " + wantedPath);
}

async function setZipEntryExternalAttributes(blob: Blob, wantedPath: string, attributes: number): Promise<Blob> {
  const entry = await findZipCentralEntry(blob, wantedPath);
  entry.view.setUint32(entry.cursor + 38, attributes >>> 0, true);
  return new Blob([entry.bytes], { type: "application/zip" });
}

async function getZipEntryExternalAttributes(blob: Blob, wantedPath: string): Promise<number> {
  const entry = await findZipCentralEntry(blob, wantedPath);
  return entry.view.getUint32(entry.cursor + 38, true);
}

async function readRawZipEntry(blob: Blob, wantedPath: string): Promise<Uint8Array | null> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lowerBound = Math.max(0, bytes.length - 65_557);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= lowerBound; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50 &&
        offset + 22 + view.getUint16(offset + 20, true) === bytes.length) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) return null;
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    if (name === wantedPath) {
      if (view.getUint32(localOffset, true) !== 0x04034b50) return null;
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      return bytes.slice(dataOffset, dataOffset + compressedSize);
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}
// @ts-expect-error The static browser helper is a plain JavaScript module under public/.
import { createProjectZip, createUpdatedProjectZip, extractOfficeText, parseProjectBundleResponse, readBoundedStream, readZipTextFiles } from "../../public/codeforge/file-tools.js";

describe("CodeForge project bundle handling", () => {
  it("parses a valid project bundle and keeps the user-facing introduction", () => {
    const payload = {
      summary: "A small Vite starter project.",
      files: [
        { path: "README.md", content: "# Project\nRun npm install and npm run dev." },
        { path: "src/main.ts", content: "export const answer = 42;" },
      ],
    };
    const source = [
      "I prepared the project files.",
      "[[CODEFORGE_PROJECT_BUNDLE]]",
      JSON.stringify(payload),
      "[[/CODEFORGE_PROJECT_BUNDLE]]",
    ].join("\n");

    const result = parseProjectBundleResponse(source);
    expect(result).not.toBeNull();
    expect(result?.displayText).toBe("I prepared the project files.");
    expect(result?.files).toEqual(payload.files);
    expect(result?.summary).toBe(payload.summary);
  });

  it("rejects path traversal and secret-file paths", () => {
    const traversal = {
      files: [{ path: "../outside.js", content: "unsafe" }],
    };
    const secret = {
      files: [{ path: ".env", content: "TOKEN=not-a-real-token" }],
    };

    const wrap = (value: unknown) => [
      "[[CODEFORGE_PROJECT_BUNDLE]]",
      JSON.stringify(value),
      "[[/CODEFORGE_PROJECT_BUNDLE]]",
    ].join("\n");

    expect(parseProjectBundleResponse(wrap(traversal))).toBeNull();
    expect(parseProjectBundleResponse(wrap(secret))).toBeNull();
  });

  it("redacts common provider credentials from generated project source", () => {
    const credentials = [
      "sb_secret_" + "1234567890abcdefghijklmn",
      "sk_" + "live_1234567890abcdefghijklmn",
      "rk_" + "live_1234567890abcdefghijklmn",
      "whsec_" + "1234567890abcdefghijklmn",
      "AKIA" + "ABCDEFGHIJKLMNOP",
      "glpat-" + "abcdefghijklmnopqrstuvwxyz123456",
      "xoxb-" + "1234567890-1234567890-1234567890",
    ];
    const payload = {
      files: [{
        path: "README.md",
        content: credentials.map((value, index) => "credential_" + index + " = " + value).join("\n"),
      }],
    };
    const source = "[[CODEFORGE_PROJECT_BUNDLE]]" + JSON.stringify(payload) + "[[/CODEFORGE_PROJECT_BUNDLE]]";
    const result = parseProjectBundleResponse(source);
    expect(result).not.toBeNull();
    for (const credential of credentials) {
      expect(result?.files[0]?.content).not.toContain(credential);
    }
    expect(result?.files[0]?.content.match(/\[REDACTED SECRET\]/g)).toHaveLength(credentials.length);
  });

  it("rejects duplicate output paths", () => {
    const duplicate = {
      files: [
        { path: "src/app.ts", content: "export {};" },
        { path: "src/APP.ts", content: "export {};" },
      ],
    };
    const source = "[[CODEFORGE_PROJECT_BUNDLE]]" + JSON.stringify(duplicate) + "[[/CODEFORGE_PROJECT_BUNDLE]]";
    expect(parseProjectBundleResponse(source)).toBeNull();
  });

  it("reads a project ZIP and recovers bounded source files", async () => {
    const archive = createProjectZip([
      { path: "README.md", content: "# CodeForge project\nProject overview." },
      { path: "src/index.ts", content: "export const status = 'ready';" },
      { path: ".env.example", content: 'export const GEMINI_API_KEY = "example-secret-value-123";' },
    ]);
    const zipFile = new File([archive], "codeforge-project.zip", { type: "application/zip" });
    const result = await readZipTextFiles(zipFile);

    expect(result.files.map((file: { path: string }) => file.path)).toEqual(["README.md", "src/index.ts", ".env.example"]);
    expect(result.files[1]?.content).toContain("status = 'ready'");
    expect(result.files[2]?.path).toBe(".env.example");
    expect(result.files[2]?.content).not.toContain("example-secret-value-123");
    expect(result.files[2]?.content).toContain("[REDACTED]");
    expect(result.tree).toContain("src/index.ts");
  });

  it("cancels ZIP decompression when streamed output exceeds its declared size", async () => {
    let producedChunks = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        producedChunks += 1;
        controller.enqueue(new Uint8Array([65]));
      },
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 });

    await expect(readBoundedStream(stream, 1)).rejects.toThrow("ZIP_ENTRY_EXPANSION_LIMIT");
    expect(cancelled).toBe(true);
    expect(producedChunks).toBe(2);
  });

  it("extracts text from modern Word documents", async () => {
    const archive = createProjectZip([
      {
        path: "word/document.xml",
        content: "<w:document><w:body><w:p><w:r><w:t>CodeForge lesson content</w:t></w:r></w:p></w:body></w:document>",
      },
    ]);
    const docx = new File([archive], "lesson.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    await expect(extractOfficeText(docx)).resolves.toContain("CodeForge lesson content");
  });


  it("updates one readable CSV record while preserving other safe ZIP entries", async () => {
    const original = createProjectZip([
      { path: "README.md", content: "# Original project" },
      { path: "data/records.csv", content: "id,name,status\n1,Asha,Pending\n2,Ravi,Pending\n" },
      { path: "assets/logo.png", content: "binary-placeholder" },
    ]);
    const sourceFile = new File([original], "records.zip", { type: "application/zip" });

    const updated = await createUpdatedProjectZip(
      sourceFile,
      [{ path: "data/records.csv", content: "id,name,status\n1,Asha,Complete\n2,Ravi,Pending\n" }],
      ["README.md", "data/records.csv"],
    );
    const outputFile = new File([updated.blob], "records-updated.zip", { type: "application/zip" });
    const inspected = await readZipTextFiles(outputFile);

    expect(updated.updatedFiles).toBe(1);
    expect(updated.changePreviews).toHaveLength(1);
    expect(updated.changePreviews[0]?.path).toBe("data/records.csv");
    expect(updated.changePreviews[0]?.kind).toBe("updated");
    expect(updated.changePreviews[0]?.preview).toContain("- 1,Asha,Pending");
    expect(updated.changePreviews[0]?.preview).toContain("+ 1,Asha,Complete");
    expect(updated.addedFiles).toBe(0);
    expect(updated.preservedEntries).toBe(2);
    const originalBinary = await readRawZipEntry(original, "assets/logo.png");
    const updatedBinary = await readRawZipEntry(updated.blob, "assets/logo.png");
    expect(originalBinary).not.toBeNull();
    expect(updatedBinary).toEqual(originalBinary);
    expect(inspected.files.find((item: { path: string }) => item.path === "data/records.csv")?.content)
      .toContain("1,Asha,Complete");
    expect(inspected.files.find((item: { path: string }) => item.path === "README.md")?.content)
      .toContain("# Original project");
  });

  it("preserves executable file permissions when updating a script", async () => {
    const original = createProjectZip([
      { path: "scripts/deploy.sh", content: "#!/bin/sh\necho original\n" },
      { path: "README.md", content: "# Project" },
    ]);
    const executableOriginal = await setZipEntryExternalAttributes(
      original,
      "scripts/deploy.sh",
      (0o100755 << 16) >>> 0,
    );
    const sourceFile = new File([executableOriginal], "project.zip", { type: "application/zip" });

    const updated = await createUpdatedProjectZip(
      sourceFile,
      [{ path: "scripts/deploy.sh", content: "#!/bin/sh\necho updated\n" }],
      ["scripts/deploy.sh", "README.md"],
    );

    expect(await getZipEntryExternalAttributes(updated.blob, "scripts/deploy.sh"))
      .toBe((0o100755 << 16) >>> 0);
  });

  it("preserves a CSV's UTF-8 BOM, CRLF line endings and trailing newline", async () => {
    const original = createProjectZip([
      { path: "records.csv", content: "\uFEFFid,name\r\n1,Asha\r\n" },
    ]);
    const sourceFile = new File([original], "records.zip", { type: "application/zip" });

    const updated = await createUpdatedProjectZip(
      sourceFile,
      [{ path: "records.csv", content: "id,name\n1,Asha\n2,Ravi\n" }],
      ["records.csv"],
    );
    const raw = await readRawZipEntry(updated.blob, "records.csv");
    expect(raw).not.toBeNull();
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(raw!);
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toBe("\uFEFFid,name\r\n1,Asha\r\n2,Ravi\r\n");
  });

  it("refuses to patch an existing file that was not included in the readable ZIP context", async () => {
    const original = createProjectZip([
      { path: "src/app.ts", content: "export const app = 'original';" },
      { path: "src/hidden.ts", content: "export const hidden = 'not inspected';" },
    ]);
    const sourceFile = new File([original], "source.zip", { type: "application/zip" });

    await expect(createUpdatedProjectZip(
      sourceFile,
      [{ path: "src/hidden.ts", content: "export const hidden = 'guessed';" }],
      ["src/app.ts"],
    )).rejects.toThrow("not fully included");
  });

  it("rejects unsafe or duplicate paths in an uploaded ZIP patch", async () => {
    const original = createProjectZip([
      { path: "records.csv", content: "id,value\n1,old\n" },
    ]);
    const sourceFile = new File([original], "records.zip", { type: "application/zip" });

    await expect(createUpdatedProjectZip(
      sourceFile,
      [{ path: "../outside.csv", content: "unsafe" }],
      ["records.csv"],
    )).rejects.toThrow("unsafe or unsupported");
    await expect(createUpdatedProjectZip(
      sourceFile,
      [
        { path: "records.csv", content: "id,value\n1,new\n" },
        { path: "RECORDS.csv", content: "id,value\n1,other\n" },
      ],
      ["records.csv"],
    )).rejects.toThrow("more than once");
  });

  it("creates a downloadable ZIP blob containing the requested files", () => {
    const blob = createProjectZip([
      { path: "README.md", content: "# Hello CodeForge" },
      { path: "src/index.js", content: "console.log('ready');" },
    ]);

    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("application/zip");
    expect(blob.size).toBeGreaterThan(100);
  });
});
