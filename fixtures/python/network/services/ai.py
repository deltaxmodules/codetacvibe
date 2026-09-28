import os

from anthropic import Anthropic
from openai import AsyncOpenAI

BASE_URL = os.environ.get('AI_BASE_URL', 'http://127.0.0.1:9')


def prompt_for(text):
    return f'Resume numa frase: {text}'


async def ask_openai(text):
    client = AsyncOpenAI(base_url=f'{BASE_URL}/v1', max_retries=0)
    completion = await client.chat.completions.create(model='gpt-4o-mini', messages=[{'role': 'user', 'content': prompt_for(text)}])
    return {'answer': completion.choices[0].message.content}


async def stream_openai(text):
    client = AsyncOpenAI(base_url=f'{BASE_URL}/v1', max_retries=0)
    stream = await client.chat.completions.create(model='gpt-4o-mini', messages=[{'role': 'user', 'content': prompt_for(text)}],
                                                  stream=True, stream_options={'include_usage': True})
    parts = [chunk.choices[0].delta.content async for chunk in stream if chunk.choices and chunk.choices[0].delta.content]
    return {'answer': ''.join(parts)}


def ask_anthropic(text):
    client = Anthropic(base_url=BASE_URL, max_retries=0)
    message = client.messages.create(model='claude-sonnet-5', max_tokens=64, messages=[{'role': 'user', 'content': prompt_for(text)}])
    return {'answer': message.content[0].text}
