import { encode } from 'gpt-tokenizer'

self.addEventListener('message', (event: MessageEvent<{ id: number; text: string }>) => {
  const { id, text } = event.data
  postMessage({ id, count: encode(text ?? '').length })
})