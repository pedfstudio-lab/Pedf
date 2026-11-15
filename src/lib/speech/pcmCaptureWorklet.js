// Runs in the browser's audio thread while the microphone is on: hands each block of
// microphone samples to the page, which turns them into 16 kHz speech for live transcription.
// It is a real file on purpose. highpal.ai's safety rules only let HighPal's own files run as
// scripts, so a script built at run time (a blob: address) is blocked there and voice fails.
class DesiPdfPcmCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length > 0) this.port.postMessage(channel.slice());
    return true;
  }
}
registerProcessor('desipdf-pcm-capture', DesiPdfPcmCapture);
