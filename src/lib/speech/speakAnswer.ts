import { defaultProviders } from '@/lib/providers';

export type StopSpeech = () => void;

function speakWithBrowser(
  text: string,
  language: string,
  onEnded: () => void,
): StopSpeech {
  const synthesis = window.speechSynthesis;
  synthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = language;
  const matchingVoice = synthesis.getVoices().find((voice) => voice.lang === language);
  if (matchingVoice) utterance.voice = matchingVoice;

  let active = true;
  const finish = () => {
    if (!active) return;
    active = false;
    onEnded();
  };
  utterance.addEventListener('end', finish, { once: true });
  utterance.addEventListener('error', finish, { once: true });
  synthesis.speak(utterance);

  return () => {
    if (!active) return;
    active = false;
    synthesis.cancel();
  };
}

/** Plays Sarvam audio when available, with speechSynthesis as the free UI fallback. */
export async function speakAnswer(
  text: string,
  language: string,
  onEnded: () => void = () => undefined,
): Promise<StopSpeech> {
  try {
    const { audio } = await defaultProviders().speak({ text, language });
    const url = URL.createObjectURL(audio);
    const element = new Audio(url);
    let active = true;

    const finish = () => {
      if (!active) return;
      active = false;
      URL.revokeObjectURL(url);
      onEnded();
    };
    element.addEventListener('ended', finish, { once: true });
    element.addEventListener('error', finish, { once: true });

    try {
      await element.play();
    } catch (error) {
      active = false;
      URL.revokeObjectURL(url);
      throw error;
    }

    return () => {
      if (!active) return;
      active = false;
      element.pause();
      URL.revokeObjectURL(url);
    };
  } catch {
    return speakWithBrowser(text, language, onEnded);
  }
}
