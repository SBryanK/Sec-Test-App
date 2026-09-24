import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import React from 'react';

/**
 * Minimal, dependency-free i18n.
 *
 * The reference app ships an EN / 中文 toggle in Profile. Only UI chrome is
 * translated — test names, payloads and technical evidence stay in English,
 * which is what a bilingual operator actually wants.
 */

export type Language = 'en' | 'zh';

const en = {
  'tab.search': 'Search',
  'tab.test': 'Test',
  'tab.history': 'History',
  'tab.profile': 'Profile',

  'splash.loading': 'Preparing secure session…',

  'login.title': 'Sign in',
  'login.subtitle': 'Authorised operators only. All activity is logged.',
  'login.email': 'Email',
  'login.password': 'Password',
  'login.submit': 'Sign in',
  'login.signingIn': 'Signing in…',
  'login.failed': 'Sign-in failed',

  'search.title': 'Validate Connection',
  'search.placeholder': 'Enter Domain/URL/IP',
  'search.tip': 'Tip: Enter multiple URLs/IPs separated by commas, semicolons, or new lines',
  'search.test': 'Test Connection',
  'search.testing': 'Testing…',
  'search.reachable': 'Reachable',
  'search.unreachable': 'Unreachable',
  'search.noResults': 'Enter a target to validate reachability, TLS and edge routing.',
  'search.timing': 'Timing breakdown',
  'search.edge': 'Edge / WAF',
  'search.tls': 'TLS',

  'test.title': 'Security Tests',
  'test.importConfig': 'Import Config',
  'test.runAll': 'Run All Tests',
  'test.runAllHint': 'Launch all {count} tests against one target, simultaneously',
  'test.cart': 'Cart',
  'test.addToCart': 'Add to Cart',
  'test.addedToCart': 'Added to cart',
  'test.selectType': 'Select Test Type',

  'config.defaults': 'Defaults',
  'config.advanced': 'Advanced',
  'config.save': 'Save',
  'config.import': 'Import',
  'config.domain': 'Primary Target',
  'config.domainPlaceholder': 'Target Domain/IP',
  'config.saved': 'Configuration saved',

  'cart.title': 'Cart',
  'cart.empty': 'Your cart is empty',
  'cart.emptyHint': 'Add a test from the Test tab to build a run.',
  'cart.credits': '{count} credit(s)',
  'cart.confirm': 'Confirm & Start',
  'cart.starting': 'Starting…',
  'cart.clear': 'Clear cart',
  'cart.remove': 'Remove',
  'cart.defaults': 'View defaults',
  'cart.customise': 'Customise',

  'run.title': 'Running',
  'run.preparing': 'Preparing run…',
  'run.complete': 'Run complete',
  'run.failed': 'Run failed',
  'run.cancelled': 'Run cancelled',
  'run.cancel': 'Cancel run',
  'run.probes': '{done} / {total} probes',
  'run.rps': '{rps} req/s',
  'run.viewResults': 'View results',
  'run.combined': 'Combined run detail',
  'run.perTest': 'Per-test detail',

  'result.title': 'Results',
  'result.summary': 'Summary',
  'result.findings': 'Findings',
  'result.noFindings': 'No actionable findings',
  'result.noFindingsHint': 'Protection held against every probe in this run.',
  'result.traces': 'Request log',
  'result.export': 'Export',
  'result.verify': 'Re-check',
  'result.severity': 'Severity',
  'result.evidence': 'Evidence',
  'result.remediation': 'Remediation',
  'result.references': 'References',
  'result.forensics': 'Per-request telemetry',
  'result.blocked': 'Blocked',
  'result.bypassed': 'Bypassed',
  'result.passed': 'Passed',
  'result.errors': 'Errors',

  'history.title': 'History',
  'history.searchPlaceholder': 'Search Domain/IP/Test',
  'history.syncNow': 'Sync now',
  'history.exportAll': 'Export All',
  'history.filters': 'Filters',
  'history.status': 'Status',
  'history.category': 'Category',
  'history.anyStatus': 'Any Status',
  'history.all': 'All',
  'history.domainContains': 'Domain contains',
  'history.from': 'From',
  'history.to': 'To',
  'history.clearFilters': 'Clear filters',
  'history.apply': 'Apply',
  'history.empty': 'No runs yet',
  'history.emptyHint': 'Completed runs appear here with their full result set.',
  'history.duration': 'Duration',
  'history.credits': 'Credits',

  'profile.title': 'Profile',
  'profile.userCredits': 'User Credits',
  'profile.privacyPolicy': 'Privacy Policy',
  'profile.help': 'Help',
  'profile.logOut': 'Log Out',
  'profile.apiEndpoint': 'API endpoint',
  'profile.language': 'Language',

  'credits.title': 'User Credits',
  'credits.used': 'Used',
  'credits.remaining': 'Remaining',
  'credits.request': 'Request Credits',
  'credits.requested': 'Request submitted',
  'credits.note': 'Admin will receive an email to approve the request.',

  'common.cancel': 'Cancel',
  'common.done': 'Done',
  'common.close': 'Close',
  'common.retry': 'Retry',
  'common.copy': 'Copy',
  'common.copied': 'Copied',
  'common.error': 'Something went wrong',
  'common.ok': 'OK',
} as const;

export type TranslationKey = keyof typeof en;

const zh: Record<TranslationKey, string> = {
  'tab.search': '搜索',
  'tab.test': '测试',
  'tab.history': '历史',
  'tab.profile': '我的',

  'splash.loading': '正在准备安全会话…',

  'login.title': '登录',
  'login.subtitle': '仅限授权操作员。所有活动均被记录。',
  'login.email': '邮箱',
  'login.password': '密码',
  'login.submit': '登录',
  'login.signingIn': '登录中…',
  'login.failed': '登录失败',

  'search.title': '验证连接',
  'search.placeholder': '输入域名/URL/IP',
  'search.tip': '提示：可输入多个 URL/IP，用逗号、分号或换行分隔',
  'search.test': '测试连接',
  'search.testing': '测试中…',
  'search.reachable': '可访问',
  'search.unreachable': '不可访问',
  'search.noResults': '输入目标以验证可达性、TLS 与边缘路由。',
  'search.timing': '耗时明细',
  'search.edge': '边缘 / WAF',
  'search.tls': 'TLS',

  'test.title': '安全测试',
  'test.importConfig': '导入配置',
  'test.runAll': '运行全部测试',
  'test.runAllHint': '对同一目标同时发起全部 {count} 项测试',
  'test.cart': '任务车',
  'test.addToCart': '加入任务车',
  'test.addedToCart': '已加入任务车',
  'test.selectType': '选择测试类型',

  'config.defaults': '默认值',
  'config.advanced': '高级',
  'config.save': '保存',
  'config.import': '导入',
  'config.domain': '主要目标',
  'config.domainPlaceholder': '目标域名/IP',
  'config.saved': '配置已保存',

  'cart.title': '任务车',
  'cart.empty': '任务车为空',
  'cart.emptyHint': '在“测试”页添加测试以组建任务。',
  'cart.credits': '{count} 点数',
  'cart.confirm': '确认并开始',
  'cart.starting': '启动中…',
  'cart.clear': '清空任务车',
  'cart.remove': '移除',
  'cart.defaults': '查看默认值',
  'cart.customise': '自定义',

  'run.title': '执行中',
  'run.preparing': '正在准备…',
  'run.complete': '执行完成',
  'run.failed': '执行失败',
  'run.cancelled': '已取消',
  'run.cancel': '取消执行',
  'run.probes': '{done} / {total} 个请求',
  'run.rps': '{rps} 请求/秒',
  'run.viewResults': '查看结果',
  'run.combined': '合并执行详情',
  'run.perTest': '按测试查看',

  'result.title': '结果',
  'result.summary': '概要',
  'result.findings': '发现',
  'result.noFindings': '无待处理发现',
  'result.noFindingsHint': '本次执行的所有请求均被防护拦截。',
  'result.traces': '请求日志',
  'result.export': '导出',
  'result.verify': '复验',
  'result.severity': '严重级别',
  'result.evidence': '证据',
  'result.remediation': '修复建议',
  'result.references': '参考',
  'result.forensics': '单请求遥测',
  'result.blocked': '已拦截',
  'result.bypassed': '已绕过',
  'result.passed': '通过',
  'result.errors': '错误',

  'history.title': '历史',
  'history.searchPlaceholder': '搜索域名/IP/测试',
  'history.syncNow': '立即同步',
  'history.exportAll': '全部导出',
  'history.filters': '筛选',
  'history.status': '状态',
  'history.category': '分类',
  'history.anyStatus': '全部状态',
  'history.all': '全部',
  'history.domainContains': '域名包含',
  'history.from': '开始',
  'history.to': '结束',
  'history.clearFilters': '清除筛选',
  'history.apply': '应用',
  'history.empty': '暂无记录',
  'history.emptyHint': '完成的执行会连同完整结果显示在此处。',
  'history.duration': '耗时',
  'history.credits': '点数',

  'profile.title': '我的',
  'profile.userCredits': '用户点数',
  'profile.privacyPolicy': '隐私政策',
  'profile.help': '帮助',
  'profile.logOut': '退出登录',
  'profile.apiEndpoint': '接口地址',
  'profile.language': '语言',

  'credits.title': '用户点数',
  'credits.used': '已用',
  'credits.remaining': '剩余',
  'credits.request': '申请点数',
  'credits.requested': '申请已提交',
  'credits.note': '管理员将收到邮件以批准该申请。',

  'common.cancel': '取消',
  'common.done': '完成',
  'common.close': '关闭',
  'common.retry': '重试',
  'common.copy': '复制',
  'common.copied': '已复制',
  'common.error': '出现问题',
  'common.ok': '好的',
};

const translations: Record<Language, Record<TranslationKey, string>> = { en, zh };

interface I18nState {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nState | null>(null);

export function I18nProvider({
  children,
  initial = 'en',
}: {
  children: ReactNode;
  initial?: Language;
}): React.JSX.Element {
  const [language, setLanguage] = useState<Language>(initial);

  const t = useCallback(
    (key: TranslationKey, vars?: Record<string, string | number>) => {
      let value = translations[language][key] ?? translations.en[key] ?? key;
      if (vars) {
        for (const [name, replacement] of Object.entries(vars)) {
          value = value.replace(new RegExp(`\\{${name}\\}`, 'g'), String(replacement));
        }
      }
      return value;
    },
    [language],
  );

  const value = useMemo<I18nState>(() => ({ language, setLanguage, t }), [language, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nState {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside <I18nProvider>');
  return ctx;
}
