import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    WEAVEFOX_ICON_SERVICE, ICONIFY_API, iconifyUrl, decideIconRequest, iconSearchBody,
} from '../infographic-icons';

/** The URL the library requests for an icon search. */
const search = (text: string): string => `${WEAVEFOX_ICON_SERVICE}?text=${encodeURIComponent(text)}`;

describe('iconifyUrl', () => {
    it('maps prefix/name to the Iconify SVG endpoint', () => {
        assert.equal(iconifyUrl('mdi/home'), `${ICONIFY_API}/mdi/home.svg`);
    });

    it('accepts Iconify\'s own prefix:name spelling', () => {
        assert.equal(iconifyUrl('mdi:home'), `${ICONIFY_API}/mdi/home.svg`);
    });

    it('accepts hyphenated prefixes and names', () => {
        assert.equal(iconifyUrl('material-symbols/arrow-back-ios'),
            `${ICONIFY_API}/material-symbols/arrow-back-ios.svg`);
    });

    it('lower-cases, since every Iconify name is lowercase', () => {
        assert.equal(iconifyUrl('MDI/Home'), `${ICONIFY_API}/mdi/home.svg`);
    });

    it('ignores surrounding whitespace', () => {
        assert.equal(iconifyUrl('  mdi/home \n'), `${ICONIFY_API}/mdi/home.svg`);
    });

    // Anything that is not an icon name is document text, and must not be sent.
    for (const query of [
        'Capture the trace',        // a label — the library's fallback query
        'home',                     // no prefix
        'mdi/home/extra',           // a path, not a name
        '../etc/passwd',
        'mdi/../secret',
        'mdi/home?x=1',
        'mdi/--home',               // Iconify never doubles or leads with a hyphen
        'mdi/home-',
        '',
    ]) {
        it(`refuses ${JSON.stringify(query)}`, () => {
            assert.equal(iconifyUrl(query), null);
        });
    }
});

describe('decideIconRequest — the icon search', () => {
    it('iconify: an icon name becomes a fetch of exactly that icon', () => {
        assert.deepEqual(decideIconRequest(search('mdi/home'), 'iconify'),
            { kind: 'iconify', query: 'mdi/home', url: `${ICONIFY_API}/mdi/home.svg` });
    });

    it('iconify: free text is answered "nothing found", with no request at all', () => {
        // The label/desc fallback lands here — document prose never leaves.
        assert.deepEqual(decideIconRequest(search('Restart the orphaned server'), 'iconify'),
            { kind: 'no-result', query: 'Restart the orphaned server' });
    });

    it('iconify: a search with no query is answered "nothing found"', () => {
        assert.deepEqual(decideIconRequest(WEAVEFOX_ICON_SERVICE, 'iconify'), { kind: 'no-result', query: '' });
    });

    it('weavefox: the search goes to WeaveFox unchanged — free text included', () => {
        const url = search('Restart the orphaned server');
        assert.deepEqual(decideIconRequest(url, 'weavefox'),
            { kind: 'weavefox', query: 'Restart the orphaned server', url });
    });

    it('none: every search is answered "nothing found"', () => {
        assert.deepEqual(decideIconRequest(search('mdi/home'), 'none'), { kind: 'no-result', query: 'mdi/home' });
    });
});

describe('decideIconRequest — anything else', () => {
    it('is a remote asset the document named, fetched through the guarded fetcher', () => {
        const url = 'https://example.com/logo.svg';
        assert.deepEqual(decideIconRequest(url, 'iconify'), { kind: 'remote', url });
        assert.deepEqual(decideIconRequest(url, 'weavefox'), { kind: 'remote', url });
    });

    it('is refused outright under none', () => {
        const url = 'https://example.com/logo.svg';
        assert.deepEqual(decideIconRequest(url, 'none'), { kind: 'blocked', url });
    });

    it('does not mistake a look-alike host for the search endpoint', () => {
        // Were this read as the search, iconify would treat it as policy-covered;
        // it is simply a remote URL, and never counts as a WeaveFox request.
        const url = 'https://www.weavefox.cn.example.com/api/v1/infographic/icon?text=x';
        assert.equal(decideIconRequest(url, 'iconify').kind, 'remote');
        assert.equal(decideIconRequest(url, 'weavefox').kind, 'remote');
    });

    it('does not mistake a longer path on the same host for the search endpoint', () => {
        const url = `${WEAVEFOX_ICON_SERVICE}/other?text=x`;
        assert.equal(decideIconRequest(url, 'weavefox').kind, 'remote');
    });

    for (const url of ['file:///etc/passwd', 'data:image/svg+xml,<svg/>', 'ftp://example.com/x.svg']) {
        it(`refuses a non-http scheme: ${url.slice(0, 20)}…`, () => {
            assert.equal(decideIconRequest(url, 'iconify').kind, 'blocked');
            assert.equal(decideIconRequest(url, 'weavefox').kind, 'blocked');
        });
    }

    it('refuses a URL it cannot parse', () => {
        assert.deepEqual(decideIconRequest('not a url', 'iconify'), { kind: 'blocked', url: 'not a url' });
    });
});

describe('iconSearchBody', () => {
    it('answers with the one icon, in the shape the library reads', () => {
        assert.deepEqual(JSON.parse(iconSearchBody('<svg/>')), { success: true, data: ['<svg/>'] });
    });

    it('answers "nothing found" for null', () => {
        assert.deepEqual(JSON.parse(iconSearchBody(null)), { success: false, data: [] });
    });
});
