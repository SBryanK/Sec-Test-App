import type { TestCategory, TestDefinition } from '../types';
import {
  bodyField,
  headersField,
  importTemplatesNote,
  linesField,
  methodField,
  numberField,
  pathField,
  queryField,
  SECTION,
} from './helpers';

/** DoS Protection — load-generation tests. These run on the server executor. */
export const dosTests: TestDefinition[] = [
  {
    id: 'http_spike',
    category: 'dos_protection',
    label: 'HTTP Spike Test',
    shortLabel: 'DoS Spike',
    icon: 'pulse',
    blurb: 'Burst a configured number of HTTP requests to test rate limiting and origin resilience.',
    feasibility: 'hybrid',
    feasibilityNote:
      'A handset can originate a spike of a few hundred requests, but carrier NAT and mobile radio limits cap real intensity. The server executor is used for anything above the device ceiling.',
    creditCost: 1,
    defaultDurationMs: 15000,
    http: { method: 'GET', path: '/' },
    sections: [
      { id: SECTION.target, title: 'Primary Target' },
      { id: SECTION.templates, title: '' },
      { id: 'spike_http', title: 'HTTP Spike Parameters', accent: true },
      { id: 'request', title: '' },
      { id: 'spike_attack', title: 'HTTP Spike Attack Parameters' },
    ],
    fields: [
      importTemplatesNote,
      methodField('spike_http', 'GET'),
      pathField('spike_http', '/'),
      queryField('request', []),
      headersField('request', []),
      bodyField('request', ''),
      numberField('spike.burst', 'spike_attack', 'Burst Requests', {
        min: 10,
        max: 1000,
        def: 500,
        hint: 'Total number of requests to send (10-1000)',
      }),
      numberField('spike.interval', 'spike_attack', 'Request Interval (ms)', {
        min: 10,
        max: 5000,
        def: 50,
        hint: 'Delay between requests in milliseconds (10-5000)',
      }),
      numberField('spike.threads', 'spike_attack', 'Concurrent Threads', {
        min: 1,
        max: 50,
        def: 20,
        hint: 'Number of parallel threads (1-50)',
      }),
      numberField('spike.duration', 'spike_attack', 'Test Duration (seconds)', {
        min: 5,
        max: 600,
        def: 60,
        hint: 'Duration for the test (5-600 seconds)',
      }),
    ],
  },
  {
    id: 'connection_flood',
    category: 'dos_protection',
    label: 'Connection Flood Test',
    shortLabel: 'Connection Flood',
    icon: 'git-network',
    blurb: 'Hold many parallel TCP connections open while issuing a target request rate.',
    feasibility: 'hybrid',
    feasibilityNote:
      'Opening 100 parallel sockets is achievable on a handset, but file-descriptor limits and carrier NAT throttling prevent true L4 exhaustion. Sustained flooding runs on the server executor.',
    creditCost: 1,
    defaultDurationMs: 20000,
    http: {
      method: 'GET',
      path: '/',
      headers: [
        { key: 'Accept-Language', value: 'en-US,en;q=0.5' },
        { key: 'Accept-Encoding', value: 'gzip, deflate' },
        { key: 'Connection', value: 'keep-alive' },
        { key: 'Cache-Control', value: 'no-cache' },
      ],
    },
    sections: [
      { id: SECTION.target, title: 'Primary Target' },
      { id: SECTION.templates, title: '' },
      { id: 'flood_params', title: 'Connection Flood Parameters' },
      { id: SECTION.http, title: 'HTTP Request Configuration', accent: true },
      { id: 'request', title: '' },
      { id: 'traffic', title: 'Traffic Parameters' },
    ],
    fields: [
      importTemplatesNote,
      numberField('flood.duration', 'flood_params', 'Test Duration (seconds)', {
        min: 5,
        max: 300,
        def: 60,
        hint: 'How long to run the flood attack (5-300 seconds)',
      }),
      numberField('flood.connections', 'flood_params', 'Concurrent Connections', {
        min: 1,
        max: 100,
        def: 100,
        hint: 'Number of parallel connections (1-100)',
      }),
      numberField('flood.rps', 'flood_params', 'Requests Per Second (RPS)', {
        min: 1,
        max: 1000,
        def: 50,
        hint: 'Target request rate (1-1000 RPS)',
      }),
      methodField(SECTION.http, 'GET'),
      pathField(SECTION.http, '/'),
      queryField('request', []),
      bodyField('request', ''),
      headersField('request', [
        { key: 'Accept-Language', value: 'en-US,en;q=0.5' },
        { key: 'Accept-Encoding', value: 'gzip, deflate' },
        { key: 'Connection', value: 'keep-alive' },
        { key: 'Cache-Control', value: 'no-cache' },
      ]),
      numberField('traffic.users', 'traffic', 'Concurrent Users', {
        min: 1,
        max: 100,
        def: 5,
        hint: 'Number of concurrent users (1-100)',
      }),
      numberField('traffic.duration', 'traffic', 'Test Duration (seconds)', {
        min: 5,
        max: 300,
        def: 60,
        hint: 'Duration for connection flood test (5-300 seconds)',
      }),
    ],
  },
];

export const dosCategory: TestCategory = {
  id: 'dos_protection',
  label: 'DoS Protection',
  icon: 'speedometer',
  accent: '#3B7DFF',
  blurb: 'Load and rate-limit resilience',
  testIds: ['http_spike', 'connection_flood'],
};
