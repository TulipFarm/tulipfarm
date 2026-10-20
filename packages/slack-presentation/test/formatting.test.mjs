import assert from 'node:assert/strict';
import test from 'node:test';
import { renderSlackAnswer, parseSlackSurface, slackOutboundText } from '../dist/index.js';

test('Markdown emphasis becomes styled rich text, not literal asterisks', () => {
  const result = parseSlackSurface(renderSlackAnswer('**Bold** and *italic* and ~~gone~~.'));
  assert.deepEqual(result.blocks[0].elements[0].elements, [
    { type: 'text', text: 'Bold', style: { bold: true } },
    { type: 'text', text: ' and ' },
    { type: 'text', text: 'italic', style: { italic: true } },
    { type: 'text', text: ' and ' },
    { type: 'text', text: 'gone', style: { strike: true } },
    { type: 'text', text: '.' },
  ]);
  assert.equal(result.text, 'Bold and italic and gone.');
});

test('code, nested emphasis, links, lists and literal stars retain meaning', () => {
  const result = renderSlackAnswer(
    '**bold _inside_** `a * b` \\*literal\\* [site](https://example.com)\n\n3. first\n4. second\n\n```js\n**not bold**\n```',
  );
  assert.deepEqual(result.blocks[0].elements[0].elements[1], {
    type: 'text',
    text: 'inside',
    style: { bold: true, italic: true },
  });
  assert.equal(result.blocks[0].elements[0].elements.find(element => element.style?.code).text, 'a * b');
  assert.equal(result.blocks[0].elements.at(-1).elements[0].text, '**not bold**');
  assert.match(result.text, /3\. first/);
  assert.match(result.text, /\*literal\*/);
  assert.deepEqual(result.blocks[0].elements[0].elements.at(-1), {
    type: 'link',
    url: 'https://example.com/',
    text: 'site',
  });
});

for (const mention of ['<!channel>', '<!here>', '<@U123>', '<#C123>', '<!subteam^S123>']) {
  test(`leading ${mention} stays inert while bold and links remain structured`, () => {
    const result = renderSlackAnswer(`${mention} **Warning** [Details](https://example.com)`);
    assert.equal(result.text, `${mention} Warning Details`);
    assert.deepEqual(result.blocks[0].elements[0].elements, [
      { type: 'text', text: `${mention} ` },
      { type: 'text', text: 'Warning', style: { bold: true } },
      { type: 'text', text: ' ' },
      { type: 'link', text: 'Details', url: 'https://example.com/' },
    ]);
  });
}

test('HTML stays inert without swallowing subsequent Markdown', () => {
  const result = renderSlackAnswer('<div> **Warning** [Details](https://example.com)');
  assert.equal(result.text, '<div> Warning Details');
  assert.deepEqual(
    result.blocks[0].elements[0].elements.find(element => element.style?.bold),
    { type: 'text', text: 'Warning', style: { bold: true } },
  );
});

test('unsafe and credential-bearing links become inert labels', () => {
  const result = renderSlackAnswer('[bad](javascript:alert%281%29) [secret](https://user:pass@example.com)');
  assert.equal(result.text, 'bad secret');
  assert.deepEqual(result.blocks[0].elements[0].elements, [
    { type: 'text', text: 'bad' },
    { type: 'text', text: ' ' },
    { type: 'text', text: 'secret' },
  ]);
});

test('outbound projection retains destinations within paragraphs, lists, quotes and tables', () => {
  assert.equal(slackOutboundText('[Report](https://example.com/report)'), 'Report (https://example.com/report)');
  assert.equal(slackOutboundText('3. [Report](https://example.com/report)'), '3. Report (https://example.com/report)');
  assert.equal(slackOutboundText('> [Report](https://example.com/report)'), 'Report (https://example.com/report)');
  assert.equal(
    slackOutboundText('| Document |\n| --- |\n| [Report](https://example.com/report) |'),
    'Document\nReport (https://example.com/report)',
  );
  assert.equal(
    slackOutboundText('`**literal**` and https://example.com/report'),
    '**literal** and https://example.com/report',
  );
  assert.equal(renderSlackAnswer('[Report](https://example.com/report)').text, 'Report');
});

test('empty and oversized answers fail rather than truncate meaning', () => {
  assert.throws(() => renderSlackAnswer(' '), /slack-answer-size/);
  assert.throws(() => renderSlackAnswer('x'.repeat(65537)), /slack-answer-size/);
  assert.throws(() => slackOutboundText('x'.repeat(40001)), /slack-answer-size/);
  assert.equal(renderSlackAnswer('Ready').text, 'Ready');
});

test('reference definitions never become visible content or expose rejected destinations', () => {
  const valid = '[Report][report]\n\n[report]: https://example.com/report';
  assert.equal(renderSlackAnswer(valid).text, 'Report');
  assert.equal(slackOutboundText(valid), 'Report (https://example.com/report)');
  for (const url of ['https://user:pass@example.com', 'javascript:alert%281%29']) {
    const input = `[label][ref]\n\n[ref]: ${url}`;
    assert.deepEqual(renderSlackAnswer(input).blocks[0].elements, [
      { type: 'rich_text_section', elements: [{ type: 'text', text: 'label' }] },
    ]);
    assert.equal(slackOutboundText(input), 'label');
  }
});

test('entities decode once in text but remain literal in code and escaped text', () => {
  const input = 'Tom &amp; Jerry &copy; &#169; &#xA9; &amp;copy; &#38;copy; &copy &#169';
  const expected = 'Tom & Jerry © © © &copy; &copy; &copy &#169';
  assert.equal(renderSlackAnswer(input).text, expected);
  assert.equal(slackOutboundText(input), expected);
  for (const code of ['`&amp;`', '```\n&amp;\n```', '\\&amp;']) {
    assert.equal(renderSlackAnswer(code).text, '&amp;');
    assert.equal(slackOutboundText(code), '&amp;');
  }
  assert.deepEqual(renderSlackAnswer('&lt;!channel&gt;').blocks[0].elements, [
    { type: 'rich_text_section', elements: [{ type: 'text', text: '<!channel>' }] },
  ]);
});

test('entities decode in link and image labels and destinations before URL validation', () => {
  for (const prefix of ['', '!']) {
    const input = `${prefix}[Tom &amp; Jerry](https://example.com/report?a=1&amp;b=2)`;
    assert.deepEqual(renderSlackAnswer(input).blocks[0].elements[0].elements, [
      { type: 'link', text: 'Tom & Jerry', url: 'https://example.com/report?a=1&b=2' },
    ]);
    assert.equal(slackOutboundText(input), 'Tom & Jerry (https://example.com/report?a=1&b=2)');
    const unsafe = `${prefix}[label](javascript&#58;alert%281%29)`;
    assert.equal(renderSlackAnswer(unsafe).text, 'label');
    assert.equal(slackOutboundText(unsafe), 'label');
  }
});

test('list continuations retain source order without inventing another item', () => {
  const input = '- before\n  - nested\n\n  after';
  const expected = '• before\n\n• nested\n\nafter';
  assert.equal(renderSlackAnswer(input).text, expected);
  assert.equal(slackOutboundText(input), expected);
  assert.deepEqual(
    renderSlackAnswer(input).blocks[0].elements.map(block => [block.type, block.indent]),
    [
      ['rich_text_list', 0],
      ['rich_text_list', 1],
      ['rich_text_section', undefined],
    ],
  );
});

test('list block code and continuation preserve formatting and next item numbering', () => {
  const input = '3. before\n\n   ```js\n   a * b &amp;\n   ```\n\n   after\n4. next';
  const result = renderSlackAnswer(input);
  assert.equal(result.text, '3. before\n\na * b &amp;\n\nafter\n\n4. next');
  assert.equal(slackOutboundText(input), '3. before\n\na * b &amp;\n\nafter\n\n4. next');
  assert.deepEqual(result.blocks[0].elements[1], {
    type: 'rich_text_preformatted',
    elements: [{ type: 'text', text: 'a * b &amp;' }],
  });
  assert.equal(renderSlackAnswer('- [x] done\n- [ ] pending').text, '• ☑ done\n\n• ☐ pending');
});

for (const [name, first, next, padding, marker, nextMarker] of [
  ['ordered', '3.', '4.', '   ', '3.', '4.'],
  ['unordered', '-', '-', '  ', '•', '•'],
]) {
  for (const [kind, markdown, text] of [
    ['rich_text_quote', `> quoted\n${padding}> continuation`, 'quoted\ncontinuation'],
    [
      'rich_text_preformatted',
      `\`\`\`js\n${padding}x * y &amp;\n${padding}second line\n${padding}\`\`\``,
      'x * y &amp;\nsecond line',
    ],
  ]) {
    test(`${name} list preserves its marker and leading ${kind} formatting`, () => {
      const input = `${first} ${markdown}\n\n${padding}after\n${next} next`;
      const expected = `${marker} ${text}\n\nafter\n\n${nextMarker} next`;
      const result = renderSlackAnswer(input);
      assert.equal(result.text, expected);
      assert.equal(slackOutboundText(input), expected);
      assert.deepEqual(result.blocks[0].elements[0], {
        type: kind,
        elements: [
          { type: 'text', text: `${marker} ` },
          { type: 'text', text },
        ],
      });
      assert.deepEqual(result.blocks[0].elements[1], {
        type: 'rich_text_section',
        elements: [{ type: 'text', text: 'after' }],
      });
    });
  }
  test(`${name} list preserves the parent marker before a leading nested list`, () => {
    const input = `${first} - nested\n${next} next`;
    const expected = `${marker}\n\n• nested\n\n${nextMarker} next`;
    const result = renderSlackAnswer(input);
    assert.equal(result.text, expected);
    assert.equal(slackOutboundText(input), expected);
    assert.deepEqual(result.blocks[0].elements[0], {
      type: 'rich_text_section',
      elements: [{ type: 'text', text: marker }],
    });
    assert.equal(result.blocks[0].elements[1].type, 'rich_text_list');
    assert.equal(result.blocks[0].elements[1].indent, 1);
  });
}
