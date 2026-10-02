import { useCallback, useEffect, useState } from "react";

/**
 * Finishes dictation and then sends. The send runs from the render after the
 * transcript lands, so it sees the new draft and the idle voice state instead
 * of the recording-era values captured when the button was pressed.
 */
export function useVoiceInputSend(input: {
  readonly stop: () => Promise<boolean>;
  readonly send: () => void;
}) {
  const [phase, setPhase] = useState<"transcribing" | "ready" | null>(null);

  useEffect(() => {
    if (phase !== "ready") return;
    setPhase(null);
    input.send();
  }, [phase]);

  const { stop } = input;
  const sendDictation = useCallback(async () => {
    setPhase("transcribing");
    // Empty speech, an edited draft, cancel, or an error leave nothing new to send.
    setPhase((await stop()) ? "ready" : null);
  }, [stop]);

  return { sending: phase !== null, sendDictation };
}
