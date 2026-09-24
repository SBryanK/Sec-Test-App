import type { TestCategory, TestDefinition } from '../types';
import {
  headersField,
  linesField,
  methodField,
  numberField,
  pathField,
  queryField,
  SECTION,
} from './helpers';

/** Bot Management — client-fingerprint and crawler-behaviour tests. */
export const botTests: TestDefinition[] = [
  {
    id: 'user_agent_anomaly',
    category: 'bot_management',
    label: 'User-Agent Anomaly Test',
    shortLabel: 'UA Anomaly',
    icon: 'bug',
    blurb: 'Replay known bot and tooling User-Agents to check bot-management detection rules.',
    feasibility: 'phone',
    feasibilityNote:
      'Header-level fingerprint replay is fully effective from a handset. The server executor additionally varies TLS/JA3 fingerprints, which a phone cannot do.',
    creditCost: 1,
    defaultDurationMs: 8000,
    http: { method: 'GET', path: '/' },
    sections: [
      { id: SECTION.target, title: 'Primary Target' },
      { id: 'ua_http', title: 'User-Agent Anomaly Parameters', accent: true },
      { id: 'ua_detect', title: 'User-Agent Anomaly Detection Parameters' },
      { id: 'request', title: '' },
    ],
    fields: [
      methodField('ua_http', 'GET'),
      pathField('ua_http', '/'),
      { id: 'ua.profiles_heading', type: 'section', section: 'ua_detect', label: 'Bot User-Agent Profiles' },
      linesField(
        'ua.profiles',
        'ua_detect',
        'Bot User-Agents (one per line)',
        [
          'Googlebot/2.1 (+http://www.google.com/bot.html)',
          'curl/7.68.0',
          'python-requests/2.28.1',
          'PostmanRuntime/7.29.2',
        ],
        'One User-Agent per line — each is replayed as a separate probe',
      ),
      {
        id: 'ua.stealth',
        type: 'checkbox',
        section: 'ua_detect',
        label: 'Use minimal headers (stealth mode)',
        default: false,
        hint: 'Sends only Host + User-Agent, the way a naive script would',
      },
      {
        id: 'ua.accept_language',
        type: 'text',
        section: 'ua_detect',
        label: 'Accept-Language Header',
        default: 'en-US,en;q=0.9',
        hint: 'Language preference for browser simulation',
      },
      queryField('request', []),
      headersField('request', []),
    ],
  },
  {
    id: 'web_crawler',
    category: 'bot_management',
    label: 'Web Crawler Test',
    shortLabel: 'Web Crawler',
    icon: 'search',
    blurb: 'Crawl the target breadth-first to check whether bot rules throttle aggressive spiders.',
    feasibility: 'hybrid',
    feasibilityNote:
      'The device can drive a shallow crawl. Depth beyond a few levels multiplies request volume and is delegated to the server executor.',
    creditCost: 1,
    defaultDurationMs: 15000,
    http: {
      method: 'GET',
      path: '/',
      query: [
        { key: 'crawl', value: 'true' },
        { key: 'depth', value: '{{PAYLOAD}}' },
      ],
      headers: [
        { key: 'User-Agent', value: '{{PAYLOAD}}' },
        {
          key: 'Accept',
          value: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      ],
    },
    sections: [
      { id: SECTION.target, title: 'Primary Target' },
      { id: 'crawl_http', title: 'Web Crawler Parameters', accent: true },
      { id: 'request', title: '' },
      { id: 'crawl_config', title: 'Crawler Config' },
    ],
    fields: [
      pathField('crawl_http', '/'),
      queryField('request', [
        { key: 'crawl', value: 'true' },
        { key: 'depth', value: '{{PAYLOAD}}' },
      ]),
      headersField('request', [
        { key: 'User-Agent', value: '{{PAYLOAD}}' },
        {
          key: 'Accept',
          value: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      ]),
      {
        id: 'crawl.depth',
        type: 'slider',
        section: 'crawl_config',
        label: 'Crawl Depth',
        min: 1,
        max: 5,
        step: 1,
        default: 2,
        hint: 'levels',
      },
      {
        id: 'crawl.respect_robots',
        type: 'segmented',
        section: 'crawl_config',
        label: 'Respect Robots.txt',
        default: 'yes',
        options: [
          { label: 'Yes', value: 'yes' },
          { label: 'No', value: 'no' },
        ],
      },
      {
        id: 'crawl.max_pages',
        type: 'number',
        section: 'crawl_config',
        label: 'Max Pages',
        min: 1,
        max: 5000,
        default: 100,
        hint: 'Upper bound on pages fetched during the crawl (1-5000)',
        advanced: true,
      },
      numberField('crawl.delay', 'crawl_config', 'Delay Between Requests (ms)', {
        min: 0,
        max: 10000,
        def: 50,
        hint: 'Polite crawl delay between page fetches (0-10000)',
      }),
    ],
  },
];

export const botCategory: TestCategory = {
  id: 'bot_management',
  label: 'Bot Management',
  icon: 'bug',
  accent: '#3B7DFF',
  blurb: 'Bot scoring and crawler rules',
  testIds: ['user_agent_anomaly', 'web_crawler'],
};
