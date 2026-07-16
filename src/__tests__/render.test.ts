import { htmlToText, propLines, truncate } from '../render';

describe('htmlToText', () => {
  it('strips tags and preserves line structure', () => {
    expect(htmlToText('<p>Hello <b>world</b></p><p>Second</p>')).toBe('Hello world\n\nSecond');
    expect(htmlToText('a<br>b<br/>c')).toBe('a\nb\nc');
    expect(htmlToText('<ul><li>one</li><li>two</li></ul>')).toBe('- one\n- two');
  });

  it('decodes common entities (whitespace collapses within a line)', () => {
    expect(htmlToText('Fish &amp; Chips &lt;3 &quot;yes&quot; &#39;no&#39; &nbsp;!')).toBe(
      'Fish & Chips <3 "yes" \'no\' !',
    );
  });

  it('drops style/script blocks and collapses blank runs to one paragraph gap', () => {
    expect(htmlToText('<style>p{color:red}</style><div>x</div>\n\n\n\n<div>y</div>')).toBe('x\n\ny');
  });

  it('passes plain text through', () => {
    expect(htmlToText('already plain')).toBe('already plain');
  });
});

describe('propLines', () => {
  it('renders only non-empty values', () => {
    expect(
      propLines([
        ['Email', 'a@b.c'],
        ['Phone', ''],
        ['City', null],
        ['Owner', undefined],
        ['Stage', 'Won'],
      ]),
    ).toBe('**Email:** a@b.c\n**Stage:** Won');
  });
});

describe('truncate', () => {
  it('cuts long strings with an ellipsis', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abc', 4)).toBe('abc');
  });
});
