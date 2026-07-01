import axios from 'axios';
import FormData from 'form-data';

let fullTranscript = '';
let onTranscriptUpdate: ((text: string) => void) | null = null;
let apiUrl = '';
let token = '';

export function initTranscription(
  url: string,
  authToken: string,
  onUpdate: (text: string) => void
): void {
  apiUrl = url;
  token = authToken;
  onTranscriptUpdate = onUpdate;
  fullTranscript = '';
}

export function resetTranscript(): void {
  fullTranscript = '';
}

export function getFullTranscript(): string {
  return fullTranscript;
}

export async function processAudioChunk(audioBuffer: Buffer, chunkIndex: number): Promise<void> {
  if (!apiUrl || !token || audioBuffer.length === 0) return;

  try {
    const form = new FormData();
    form.append('audio', audioBuffer, {
      filename: `chunk-${chunkIndex}.webm`,
      contentType: 'audio/webm',
    });

    const { data } = await axios.post(
      `${apiUrl}/api/supraleo/transcribe-chunk`,
      form,
      {
        headers: { ...form.getHeaders(), Authorization: `Bearer ${token}` },
        timeout: 30_000,
      }
    );

    const chunkText: string = data?.data?.text ?? '';
    if (chunkText.trim()) {
      fullTranscript = fullTranscript ? `${fullTranscript} ${chunkText.trim()}` : chunkText.trim();
      onTranscriptUpdate?.(fullTranscript);
    }
  } catch {
    // Transcription failure is non-fatal — call recording continues
  }
}
