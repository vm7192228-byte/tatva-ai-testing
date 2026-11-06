function metadataValue(value) {
  const bytes = new TextEncoder().encode(String(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function requestSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function waitForRetry(delayMs, signal) {
  if (signal?.aborted) {
    return Promise.reject(signal.reason || new DOMException("The upload was cancelled.", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = globalThis.setTimeout(finish, delayMs);
    const abort = () => {
      globalThis.clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason || new DOMException("The upload was cancelled.", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Uploads one file to Supabase Storage using signed TUS credentials.
 * A final HEAD is always issued after a failed PATCH, including the final
 * retry, because Storage may have accepted the bytes even when the response
 * was lost in transit.
 */
export async function uploadResumableTus(
  file,
  path,
  mimeType,
  endpoint,
  token,
  signal,
  retryDelays = [1000, 2500, 5000]
) {
  if (!file || typeof file.slice !== "function" || !Number.isSafeInteger(file.size) || file.size <= 0) {
    throw new Error("The selected file is not available for upload.");
  }
  if (typeof path !== "string" || !path || typeof mimeType !== "string" || !mimeType ||
      typeof endpoint !== "string" || !endpoint || typeof token !== "string" || !token) {
    throw new Error("Private storage returned incomplete upload credentials.");
  }

  const metadata = [
    ["bucketName", "tatv-private-uploads"],
    ["objectName", path],
    ["contentType", mimeType],
    ["cacheControl", "3600"]
  ].map(([key, value]) => key + " " + metadataValue(value)).join(",");

  let tusEndpoint;
  try {
    tusEndpoint = new URL(endpoint);
  } catch {
    throw new Error("Private storage returned an invalid resumable upload endpoint.");
  }
  // The one-time x-signature is a bearer credential. Never send it to an
  // endpoint other than the expected HTTPS Supabase Storage TUS host/path.
  if (tusEndpoint.protocol !== "https:" ||
      tusEndpoint.username || tusEndpoint.password ||
      !/^[a-z0-9-]+\.storage\.supabase\.co$/i.test(tusEndpoint.hostname) ||
      tusEndpoint.pathname !== "/storage/v1/upload/resumable" ||
      tusEndpoint.search || tusEndpoint.hash) {
    throw new Error("Private storage returned an unexpected resumable upload endpoint.");
  }

  const created = await fetch(tusEndpoint.toString(), {
    method: "POST",
    credentials: "omit",
    headers: {
      "Tus-Resumable": "1.0.0",
      "Upload-Length": String(file.size),
      "Upload-Metadata": metadata,
      "x-signature": token,
      "x-upsert": "false"
    },
    signal: requestSignal(signal, 30_000)
  });
  if (created.status !== 201) {
    throw new Error("Private storage could not start the resumable upload. Please try again.");
  }

  const location = created.headers.get("location");
  if (!location) throw new Error("Private storage did not return the resumable upload address.");
  const uploadUrl = new URL(location, tusEndpoint);
  if (uploadUrl.origin !== tusEndpoint.origin ||
      !uploadUrl.pathname.startsWith(tusEndpoint.pathname + "/") ||
      uploadUrl.username || uploadUrl.password || uploadUrl.search || uploadUrl.hash) {
    throw new Error("Private storage returned an unexpected upload address.");
  }

  let offset = Number(created.headers.get("upload-offset") || 0);
  const size = file.size;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > size) {
    throw new Error("Private storage returned an invalid upload offset.");
  }

  const chunkSize = 6 * 1024 * 1024;
  while (offset < size) {
    const end = Math.min(offset + chunkSize, size);
    let chunkFinished = false;
    let lastUploadError = null;

    for (let attempt = 0; attempt <= retryDelays.length && !chunkFinished; attempt += 1) {
      try {
        const response = await fetch(uploadUrl.toString(), {
          method: "PATCH",
          credentials: "omit",
          headers: {
            "Tus-Resumable": "1.0.0",
            "Upload-Offset": String(offset),
            "Content-Type": "application/offset+octet-stream"
          },
          body: file.slice(offset, end),
          signal: requestSignal(signal, 90_000)
        });
        if (response.status === 204) {
          const nextOffset = Number(response.headers.get("upload-offset"));
          if (!Number.isSafeInteger(nextOffset) || nextOffset !== end) {
            throw new Error("Private storage returned an unexpected upload progress value.");
          }
          offset = nextOffset;
          chunkFinished = true;
          break;
        }
        lastUploadError = new Error("Private storage interrupted a resumable upload chunk.");
      } catch (error) {
        lastUploadError = error instanceof Error ? error : new Error("Upload chunk failed.");
      }

      // A PATCH can be committed by Storage even if its response never reaches
      // the browser. Reconcile after every failure, including the final retry.
      try {
        const status = await fetch(uploadUrl.toString(), {
          method: "HEAD",
          credentials: "omit",
          headers: { "Tus-Resumable": "1.0.0" },
          signal: requestSignal(signal, 20_000)
        });
        const serverOffset = Number(status.headers.get("upload-offset"));
        if (!status.ok || !Number.isSafeInteger(serverOffset) ||
            serverOffset < offset || serverOffset > end) {
          throw new Error("Private storage returned an invalid resumable upload offset.");
        }
        offset = serverOffset;
        if (offset === end) {
          chunkFinished = true;
          break;
        }
      } catch (statusError) {
        lastUploadError = statusError instanceof Error ? statusError : lastUploadError;
      }

      if (!chunkFinished && attempt < retryDelays.length) {
        await waitForRetry(retryDelays[attempt], signal);
      }
    }

    if (!chunkFinished) {
      throw lastUploadError || new Error("Private storage could not finish the resumable upload. Please try again.");
    }
  }
}
