export const GITHUB_REPO_URL = "https://github.com/TulipFarm/tulipfarm";

export interface CapturedScreenshot {
  blob: Blob;
  dataUrl: string;
}

export function buildIssueUrl({
  title,
  description,
}: {
  title?: string;
  description?: string;
} = {}): string {
  const url = new URL(`${GITHUB_REPO_URL}/issues/new`);
  if (title?.trim()) {
    url.searchParams.set("title", title.trim());
  }
  const bodySections: string[] = [];
  if (description?.trim()) {
    bodySections.push(description.trim());
  }
  bodySections.push("(Attach the screenshot copied to your clipboard or downloaded)");
  url.searchParams.set("body", bodySections.join("\n\n"));
  url.searchParams.set("labels", "bug");
  return url.toString();
}

/*
 * Uses native getDisplayMedia to capture client pixels without adding canvas/dom-to-image dependencies.
 * Stops all media stream tracks immediately once the video frame is drawn to canvas.
 */
export async function captureScreenshot(): Promise<CapturedScreenshot | null> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    return null;
  }

  let stream: MediaStream | null = null;
  try {
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: "browser" } as MediaTrackConstraints,
        audio: false,
      });
    } catch {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
    }

    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) {
      return null;
    }

    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;

    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => {
        video.play().then(resolve).catch(reject);
      };
      video.onerror = () => reject(new Error("Failed to load video stream"));
    });

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return null;
    }

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/png");

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/png");
    });

    if (!blob) {
      return null;
    }

    return { blob, dataUrl };
  } catch {
    return null;
  } finally {
    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
    }
  }
}

export function downloadBlob(blob: Blob, filename = "tulipfarm-bug-screenshot.png"): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
