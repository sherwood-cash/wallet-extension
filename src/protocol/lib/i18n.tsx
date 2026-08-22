import { Fragment, createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

// Dependency-free i18n. To translate a new piece of the app: add the English
// string to STRINGS below under a dotted key, add the other languages next to
// it, then read it with `const { t } = useI18n()` → `t('your.key')`.
// Missing translations fall back to English, then to the key itself, so a
// half-translated language still renders.
//
// Placeholders are `{name}`, filled from the second argument:
//   t('deposit.empty', { symbol: 'ETH' })

export const LANGS = [
  { code: 'en', label: 'EN', name: 'English' },
  { code: 'zh', label: '中文', name: '简体中文' },
] as const

export type Lang = (typeof LANGS)[number]['code']

const STORAGE_KEY = 'sherwood.lang'

type Dict = Record<string, string>

const STRINGS: Record<Lang, Dict> = {
  en: {
    /* ---- landing + chrome ---- */
    'nav.docs': 'Documentation',
    'nav.launch': 'Launch app',
    'hero.tagline.1': 'Private by nature.',
    'hero.tagline.2': 'Invisible by design.',
    'lang.aria': 'Change language',

    /* ---- app nav ---- */
    'nav.assets': 'Assets',
    'nav.docsShort': 'Docs',
    'nav.referral': 'Referral',
    'nav.menu': 'Menu',

    /* ---- wallet ---- */
    'wallet.connect': 'Connect',
    'wallet.connecting': 'Connecting…',
    'wallet.connectWallet': 'Connect Wallet',
    'wallet.switchTo': 'Switch to {network}',
    'wallet.switchToShort': 'Switch to',
    'wallet.copyAddress': 'Copy address',
    'wallet.copied': 'Copied!',
    'wallet.disconnect': 'Disconnect',
    'wallet.gasBalance': 'Gas balance',
    'wallet.signIn': 'Sign in',
    'wallet.waitingSignature': 'Waiting for signature…',

    /* ---- points badge ---- */
    'points.unit': 'pts',
    'points.pending': 'Your first deposit is being valued — points land once it is confirmed and priced.',

    /* ---- tabs + card headings ---- */
    'tab.deposit': 'Deposit',
    'tab.withdraw': 'Withdraw',
    'tab.swap': 'Swap',
    'tab.bridge': 'Bridge',
    'card.deposit.subtitle': 'Deposit ETH or any token into your private balance.',
    'card.withdraw.subtitle': 'Send funds to any address. No on-chain link.',
    'card.swap.subtitle': 'Swap your shielded balance through Uniswap privately.',
    'card.bridge.subtitle': 'Move ETH between other chains and this one, in one signature.',

    /* ---- shared field labels ---- */
    'field.asset': 'Asset',
    'field.amount': 'Amount',
    'field.recipient': 'Recipient',
    'field.recipientOn': 'Recipient on {chain}',
    'field.balance': 'Balance',
    'field.privateBalance': 'Private balance',
    'field.shielded': 'Shielded',
    'btn.max': 'MAX',
    'btn.mine': 'MINE',
    'btn.working': 'Working…',
    'tx.submitted': 'submitted',

    /* ---- history ---- */
    'history.title': 'History',
    'history.empty': 'No activity yet.',
    'history.save': 'Save history',
    'history.settings': 'History settings',
    'history.enable': 'Enable history',
    'history.disable': 'Disable history',
    'history.note': 'History is stored only in this browser. Turn it off to keep nothing saved.',
    'history.deposit': 'Deposit',
    'history.withdraw': 'Withdraw',
    'history.withdrawTo': 'Withdraw → {chain}',
    'history.swap': 'Swap {from} → {to}',

    /* ---- deposit ---- */
    'deposit.bridgeHint': 'You can use our bridge to get funds on {network}',
    'deposit.empty': "You don't have any {symbol} to deposit yet.",
    'deposit.min': 'Minimum deposit is {min} ETH.',
    'deposit.cta': 'Deposit',

    /* ---- withdraw ---- */
    'withdraw.fragmented':
      'Held in {count} notes — one withdrawal can send at most {spendable} {symbol}.',
    'withdraw.consolidate': 'Consolidate',
    'withdraw.consolidating': 'Consolidating…',
    'withdraw.recipientNote': 'Sent to this address. Leftover funds stay private as a change note.',
    'withdraw.noRelayer':
      "Relayer not configured — withdrawals need a relayer so the gas payer/timing don't deanonymise the exit. Set deployment.relayerUrl.",
    'withdraw.min': "Minimum withdrawal is {min} ETH — a smaller amount can't cover the relayer's gas fee.",
    'withdraw.cta': 'Withdraw Privately',
    'withdraw.ctaTo': 'Withdraw to {chain}',
    'withdraw.rejected':
      "Withdrawal was rejected by the network. If the amount is small, note the minimum is {min} ETH — below that it can't cover the relayer's gas fee.",

    /* ---- swap ---- */
    'swap.from': 'From',
    'swap.to': 'To',
    'swap.slippage': 'Slippage',
    'swap.custom': 'Custom',
    'swap.flip': 'Flip',
    'swap.memecoinOut': '{symbol} is a memecoin — it can only be swapped into a quote asset (ETH or USDG).',
    'swap.notConfigured': 'Swaps need the SwapLogic proxy + a Uniswap router wired in deployment.json.',
    'swap.min': "Minimum swap is {min} ETH — a smaller amount can't cover the relayer's fee.",
    'swap.minCta': 'Minimum {min} ETH',
    'swap.selectAssets': 'Select assets',
    'swap.cta': 'Swap {from} → {to}',
    'swap.received': 'Received {amount} {symbol} (private note)',
    'swap.errPair': 'A memecoin can only be swapped against a quote asset (ETH or USDG).',
    'swap.errTwoAssets': 'Pick two different assets',
    'swap.errTooSmall': 'Amount too small — a swap must be at least {min} ETH to cover the relayer fee.',
    'swap.errSimulation':
      'The swap was rejected by the network (simulation failed). Try a larger amount or a different token.',

    /* ---- activity feed ---- */
    'feed.title': 'Recent activity',
    'feed.empty': 'Nothing yet — the first deposit shows up here.',
    'feed.deposited': 'Deposited',
    'feed.swapped': 'Swapped',

    /* ---- dashboard rails + ticker ---- */
    'rail.markets': 'Markets',
    'rail.marketsNote': 'Vault liquidity per asset. Pick one to load it into the ticket.',
    'rail.account': 'Your account',
    'rail.positions': 'Your positions',
    'rail.noPositions': 'Nothing shielded yet. Your first deposit shows up here.',
    'rail.activity': 'Recent activity',
    'rail.noActivity': 'No activity yet.',
    'rail.points': 'Points',
    'rail.pointsHelp':
      'Points are earned on your first deposit only: {rate} point per $1 deposited, with a ${min} minimum. Later deposits don\u2019t earn points.',
    'rail.pointsHelpShort':
      'Points are earned once, on your first deposit. Later deposits earn nothing.',
    'rail.rank': 'Rank',
    'rail.gas': 'Gas',
    'rail.unranked': 'Unranked',
    'rail.addToken': 'Add a token',
    'status.relayer': 'Relayer',
    'ticker.tvl': 'Vault TVL',
    'ticker.network': 'Network',
    'ticker.live': 'Live',
    'ticker.scanning': 'Scanning',
    'ticker.signedOut': 'Signed out',

    /* ---- assets overview ---- */
    'pools.title': 'Assets overview',
    'pools.viewCards': 'Cards',
    'pools.viewHeatmap': 'Heatmap',
    'pools.moreHidden': '+{n} more — switch to the heatmap to see every asset.',
    'pools.heatmapLegend': 'Tile size and colour = share of vault TVL.',
    'pools.heatmapOther': 'Other',
    'pools.heatmapOtherCount': '{n} assets',
    'pools.heatmapOmitted': '{n} not priced yet',
    'pools.heatmapNoUsd':
      'The heatmap needs USD values from the indexer — token amounts are not comparable across assets. Use the table view meanwhile.',
    'pools.count': '{n} assets',
    'pools.colAsset': 'Asset',
    'pools.colTvl': 'Vault TVL',
    'pools.colShielded': 'Your private balance',
    'pools.importPlaceholder': 'Import a token — 0x…',
    'pools.import': 'Import',
    'pools.importing': 'Fetching…',
    'pools.importNote':
      'Swapped tokens live only in your browser — import by address to restore a missing balance.',
    'pools.errInvalid': 'Enter a valid token address',
    'pools.errKnown': 'Already in your list',
    'pools.errNotErc20': 'Not an ERC-20 on this chain.',
    'pools.errResolve': 'Could not resolve that token',

    /* ---- token picker ---- */
    'token.afterMigration': 'After migration',
    'token.remove': 'Remove token',
    'token.close': 'Close',
    'token.search': 'Search name or paste address',
    'token.import': 'Import',
    'token.none': 'No token found.',
    'token.notErc20': 'Not an ERC-20 on this chain.',

    /* ---- errors ---- */
    'err.enterAmount': 'Enter an amount',
    'err.invalidAddress': 'Enter a valid address',
    'err.notConfigured':
      'deployment.json not set. Fill the Robinhood chainId/RPC + PrivacyVault/SwapLogic + Uniswap router addresses from your deploy.',

    /* ---- bridge ---- */
    'bridge.notConfigured':
      'Bridge not configured — it proxies Relay through the backend. Set deployment.relayerUrl (or VITE_RELAYER_URL).',
    'bridge.reverse': 'Reverse direction',
    'bridge.sendOther': 'Send to another address',
    'bridge.recipientEvm': 'Recipient on {chain} (0x…)',
    'bridge.recipientSvm': 'Recipient on {chain} (Solana address)',
    'bridge.enterRecipient': 'Enter the recipient address',
    'bridge.bridging': 'Bridging…',
    'bridge.cta': 'Bridge',
    'bridge.totalFee': 'Total fee {amount}',
    'bridge.quoteHint': 'Enter an amount for a quote',
    'bridge.view': 'View',
    'bridge.st.waiting': 'Sent — waiting for Relay to pick it up…',
    'bridge.st.pending': 'Bridging — filling on the destination chain…',
    'bridge.st.received': 'Funds received — filling…',
    'bridge.st.delayed': 'Taking longer than usual — still in progress…',
    'bridge.st.success': 'Bridge complete',
    'bridge.st.failure': 'Bridge failed',
    'bridge.st.refund': 'Could not fill — funds were refunded',

    /* ---- referral ---- */
    'ref.eyebrow': 'Referrals',
    'ref.title': 'Earn from referrals.',
    'ref.blurb':
      'Get {share} of the {fee} withdrawal fee for every user you refer. Rewards are paid instantly when they deposit.',
    'ref.yourLink': 'Your link',
    'ref.customRate': 'custom rate',
    'ref.connectNote': 'Connect your wallet to create a referral code.',
    'ref.active': 'active',
    'ref.codeNote':
      'Deposits made by anyone arriving on this link are credited to you. A wallet keeps the referrer it first deposited under, so the credit cannot be taken later.',
    'ref.pick': 'Pick a referral code. No gas, just sign a message.',
    'ref.placeholder': 'yourcode (optional)',
    'ref.create': 'Create code',
    'ref.creating': 'Creating…',
    'ref.errCode': '3–20 letters, digits, dash or underscore',
    'ref.errLoad': 'Could not load referrals',
    'ref.errCreate': 'Could not create that code',
    'ref.statEarned': 'Earned',
    'ref.statPartial': 'partial — some assets unpriced',
    'ref.statVolume': 'Deposit volume',
    'ref.statDeposits': 'Deposits',
    'ref.statWallets': 'Wallets',
    'ref.tableTitle': 'Referred deposits',
    'ref.tableEmpty':
      'Nothing yet. Share your link — credits appear once a deposit has enough confirmations.',
    'ref.colWallet': 'Wallet',
    'ref.colDeposit': 'Deposit',
    'ref.colCut': 'Your cut',
    'ref.atRate': 'at {rate}',
    'ref.copy': 'Copy',
    'ref.copied': 'Copied',
    'ref.share': 'Share on X',
    'ref.shareText': 'Trading privately on Sherwood. Use my link:',
    'ref.heroKicker': 'Invite friends, earn on every deposit',
    'ref.yourCut': 'Your cut',
    'ref.ofFee': 'of the withdrawal fee',
    'ref.noCodeYet': 'No code yet',
    'ref.emptyCta': 'Share your link to get started.',

    /* ---- first-run tour (lib/tour.ts) ---- */
    'tour.next': 'Next',
    'tour.prev': 'Back',
    'tour.done': 'Got it',
    'tour.skip': 'Skip tour',
    'tour.progress': '{{current}} of {{total}}',
    'tour.replay': 'Tutorial',
    'tour.welcome.title': 'Welcome to Sherwood',
    'tour.welcome.body':
      'Sherwood is an on-chain privacy protocol powered by zero-knowledge proofs. Deposit funds into the privacy pool, swap privately, and withdraw to a fresh wallet without creating a direct on-chain link between the deposit and withdrawal.',
    'tour.deposit.title': 'Deposit',
    'tour.deposit.body':
      'Depositing moves ETH, USDG or SHERWOOD from your wallet into the vault, and gives you a private balance that only your key can spend. This is the only public step along with the withdrawal — once deposited, all your other actions are private inside the vault.',
    'tour.swap.title': 'Swap',
    'tour.swap.body':
      'Swap your private balance through Uniswap without leaving the vault. Choose your tokens, enter an amount, and set your slippage. A relayer handles the transaction and gas, and you receive the swapped tokens back as a new private balance.',
    'tour.withdraw.title': 'Withdraw',
    'tour.withdraw.body':
      'Withdraw lets you send your private balance to any address. A relayer handles the transaction and gas, keeping your withdrawal unlinkable from your deposit. Any remaining balance stays private.',
    'tour.consolidate.title': 'Consolidate',
    'tour.consolidate.body':
      'Your balance is not a single number, it is a pile of notes — one for every deposit, swap and leftover. A single withdrawal can spend at most two of them, so after a few transactions you may see "one withdrawal can send at most X". That is what Consolidate is for: it merges your notes into a larger one so the whole balance becomes spendable in one go. It appears on the Withdraw tab, and only when you actually need it.',
    'tour.positions.title': 'Your positions',
    'tour.positions.body':
      'Every private balance this browser knows about. Use the + button to add any missing token.<br><br>Tokens you deposit or swap are saved locally in your browser. Your transaction history is also stored locally and can be disabled at any time.',
    'tour.import.title': 'Import a token',
    'tour.import.body':
      'When you swap into a token, Sherwood stores the token info locally in your browser. If you clear your data or switch devices, the balance may no longer appear, but your funds are still safe. Simply import the token address to find and display your private balance again.',
    'tour.referral.title': 'Referrals',
    'tour.referral.body':
      'Create a referral code and share your link. You earn a share of the withdrawal fees from users you refer, with rewards paid automatically. Once a wallet is linked to your referral, it stays linked to you.',
    'tour.done.title': 'That’s the whole app.',
    'tour.done.body':
      'Connect your wallet and sign in to unlock Swap and Withdraw. Deposit and Bridge work without signing in.<br><br>You can replay this tour anytime from the "?" in the footer.',

    /* ---- progress (lib/actions.ts) ---- */
    'status.proving': 'Generating zero-knowledge proof…',
    'status.submittingDeposit': 'Submitting deposit…',
    'status.approving': 'Approving token…',
    'status.signApproval': 'Sign the token approval…',
    'status.signDeposit': 'Sign the deposit…',
    'status.depositRelayer': 'Submitting deposit via relayer…',
    'status.scanning': 'Scanning your notes…',
    'status.consolidating': 'Consolidating your notes…',
    'status.consolidatingStep': 'Consolidating your notes (step {step})…',
    'status.relaying': 'Relaying withdrawal…',
    'status.relayingSwap': 'Relaying swap…',
    'status.findingPool': 'Finding the deepest pool…',
  },
  zh: {
    /* ---- landing + chrome ---- */
    'nav.docs': '文档',
    'nav.launch': '启动应用',
    'hero.tagline.1': '天生私密。',
    'hero.tagline.2': '隐形而生。',
    'lang.aria': '切换语言',

    /* ---- app nav ---- */
    'nav.assets': '资产',
    'nav.docsShort': '文档',
    'nav.referral': '推荐',
    'nav.menu': '菜单',

    /* ---- wallet ---- */
    'wallet.connect': '连接钱包',
    'wallet.connecting': '连接中…',
    'wallet.connectWallet': '连接钱包',
    'wallet.switchTo': '切换到 {network}',
    'wallet.switchToShort': '切换到',
    'wallet.copyAddress': '复制地址',
    'wallet.copied': '已复制！',
    'wallet.disconnect': '断开连接',
    'wallet.gasBalance': 'Gas 余额',
    'wallet.signIn': '登录',
    'wallet.waitingSignature': '等待签名…',

    /* ---- points badge ---- */
    'points.unit': '积分',
    'points.pending': '你的首次存入正在计价 — 交易确认并完成计价后积分即到账。',

    /* ---- tabs + card headings ---- */
    'tab.deposit': '存入',
    'tab.withdraw': '提取',
    'tab.swap': '兑换',
    'tab.bridge': '跨链',
    'card.deposit.subtitle': '将 ETH 或任意代币存入你的隐私余额。',
    'card.withdraw.subtitle': '提取到任意地址，链上不留关联。',
    'card.swap.subtitle': '通过 Uniswap 私密兑换你的隐私余额。',
    'card.bridge.subtitle': '一次签名，在其他链与本链之间转移 ETH。',

    /* ---- shared field labels ---- */
    'field.asset': '资产',
    'field.amount': '数量',
    'field.recipient': '接收地址',
    'field.recipientOn': '{chain} 上的接收地址',
    'field.balance': '钱包余额',
    'field.privateBalance': '隐私余额',
    'field.shielded': '隐私余额',
    'btn.max': '全部',
    'btn.mine': '本人',
    'btn.working': '处理中…',
    'tx.submitted': '已提交',

    /* ---- history ---- */
    'history.title': '历史记录',
    'history.empty': '暂无记录。',
    'history.save': '保存历史记录',
    'history.settings': '历史记录设置',
    'history.enable': '开启历史记录',
    'history.disable': '关闭历史记录',
    'history.note': '历史记录仅保存在本浏览器中。关闭后将不保存任何内容。',
    'history.deposit': '存入',
    'history.withdraw': '提取',
    'history.withdrawTo': '提取 → {chain}',
    'history.swap': '兑换 {from} → {to}',

    /* ---- deposit ---- */
    'deposit.bridgeHint': '可以使用我们的跨链桥把资金转入 {network}',
    'deposit.empty': '你还没有可存入的 {symbol}。',
    'deposit.min': '最低存入数量为 {min} ETH。',
    'deposit.cta': '存入',

    /* ---- withdraw ---- */
    'withdraw.fragmented': '余额分散在 {count} 张票据中 — 单次提取最多可发送 {spendable} {symbol}。',
    'withdraw.consolidate': '合并票据',
    'withdraw.consolidating': '合并中…',
    'withdraw.recipientNote': '资金将发送到此地址。剩余部分会以找零票据的形式继续保持私密。',
    'withdraw.noRelayer':
      '未配置中继器 — 提取需要中继器代付 gas，否则付款地址与时间会暴露这笔提取。请设置 deployment.relayerUrl。',
    'withdraw.min': '最低提取数量为 {min} ETH — 低于此数额不足以支付中继器的 gas 费用。',
    'withdraw.cta': '私密提取',
    'withdraw.ctaTo': '提取到 {chain}',
    'withdraw.rejected':
      '提取被网络拒绝。如果数量较小，请注意最低提取数量为 {min} ETH — 低于此数额不足以支付中继器的 gas 费用。',

    /* ---- swap ---- */
    'swap.from': '支付',
    'swap.to': '获得',
    'swap.slippage': '滑点',
    'swap.custom': '自定义',
    'swap.flip': '对调',
    'swap.memecoinOut': '{symbol} 是 memecoin — 只能兑换成计价资产（ETH 或 USDG）。',
    'swap.notConfigured': '兑换需要在 deployment.json 中配置 SwapLogic 代理和 Uniswap 路由地址。',
    'swap.min': '最低兑换数量为 {min} ETH — 低于此数额不足以支付中继器费用。',
    'swap.minCta': '最低 {min} ETH',
    'swap.selectAssets': '请选择资产',
    'swap.cta': '兑换 {from} → {to}',
    'swap.received': '已收到 {amount} {symbol}（隐私票据）',
    'swap.errPair': 'memecoin 只能与计价资产（ETH 或 USDG）互相兑换。',
    'swap.errTwoAssets': '请选择两种不同的资产',
    'swap.errTooSmall': '数量过小 — 兑换至少需要 {min} ETH 才能覆盖中继器费用。',
    'swap.errSimulation': '兑换被网络拒绝（模拟执行失败）。请尝试更大的数量或换一种代币。',

    /* ---- assets overview ---- */
    /* ---- activity feed ---- */
    'feed.title': '最新动态',
    'feed.empty': '暂无记录 — 首笔存入会显示在这里。',
    'feed.deposited': '存入',
    'feed.swapped': '兑换',

    /* ---- dashboard rails + ticker ---- */
    'rail.markets': '市场',
    'rail.marketsNote': '各资产的金库流动性。点击即可载入交易面板。',
    'rail.account': '我的账户',
    'rail.positions': '我的持仓',
    'rail.noPositions': '尚无隐私余额。首次存入后会显示在这里。',
    'rail.activity': '最近动态',
    'rail.noActivity': '暂无记录。',
    'rail.points': '积分',
    'rail.pointsHelp':
      '积分仅在首次存入时获得：每存入 1 美元得 {rate} 分，最低 ${min}。之后的存入不再产生积分。',
    'rail.pointsHelpShort': '积分仅在首次存入时获得，之后的存入不再产生积分。',
    'rail.rank': '排名',
    'rail.gas': 'Gas',
    'rail.unranked': '暂无排名',
    'rail.addToken': '添加代币',
    'status.relayer': '中继器',
    'ticker.tvl': '金库锁仓量',
    'ticker.network': '网络',
    'ticker.live': '实时',
    'ticker.scanning': '扫描中',
    'ticker.signedOut': '未登录',

    'pools.title': '资产总览',
    'pools.viewCards': '卡片',
    'pools.viewHeatmap': '热力图',
    'pools.moreHidden': '还有 {n} 项 — 切换到热力图可查看全部资产。',
    'pools.heatmapLegend': '色块大小与颜色 = 占金库锁仓量的比例。',
    'pools.heatmapOther': '其他',
    'pools.heatmapOtherCount': '{n} 种资产',
    'pools.heatmapOmitted': '{n} 项尚无计价',
    'pools.heatmapNoUsd': '热力图需要索引器提供的美元计价 — 不同资产的代币数量无法直接比较。请先使用表格视图。',
    'pools.count': '{n} 种资产',
    'pools.colAsset': '资产',
    'pools.colTvl': '金库锁仓量',
    'pools.colShielded': '你的隐私余额',
    'pools.importPlaceholder': '导入代币 — 0x…',
    'pools.import': '导入',
    'pools.importing': '获取中…',
    'pools.importNote': '兑换得到的代币仅存在于你的浏览器中 — 按地址导入即可恢复丢失的余额。',
    'pools.errInvalid': '请输入有效的代币地址',
    'pools.errKnown': '该代币已在列表中',
    'pools.errNotErc20': '这不是本链上的 ERC-20 代币。',
    'pools.errResolve': '无法解析该代币',

    /* ---- token picker ---- */
    'token.afterMigration': '迁移后开放',
    'token.remove': '移除代币',
    'token.close': '关闭',
    'token.search': '搜索名称或粘贴地址',
    'token.import': '导入',
    'token.none': '未找到代币。',
    'token.notErc20': '这不是本链上的 ERC-20 代币。',

    /* ---- errors ---- */
    'err.enterAmount': '请输入数量',
    'err.invalidAddress': '请输入有效地址',
    'err.notConfigured':
      'deployment.json 尚未配置。请填入部署得到的 Robinhood chainId/RPC、PrivacyVault/SwapLogic 以及 Uniswap 路由地址。',

    /* ---- bridge ---- */
    'bridge.notConfigured':
      '未配置跨链桥 — 它通过后端代理 Relay。请设置 deployment.relayerUrl（或 VITE_RELAYER_URL）。',
    'bridge.reverse': '调换方向',
    'bridge.sendOther': '发送到其他地址',
    'bridge.recipientEvm': '{chain} 上的接收地址（0x…）',
    'bridge.recipientSvm': '{chain} 上的接收地址（Solana 地址）',
    'bridge.enterRecipient': '请输入接收地址',
    'bridge.bridging': '跨链中…',
    'bridge.cta': '跨链转移',
    'bridge.totalFee': '总费用 {amount}',
    'bridge.quoteHint': '输入数量以获取报价',
    'bridge.view': '查看',
    'bridge.st.waiting': '已发送 — 等待 Relay 接单…',
    'bridge.st.pending': '跨链中 — 正在目标链上完成…',
    'bridge.st.received': '资金已收到 — 正在完成…',
    'bridge.st.delayed': '耗时比平常更久 — 仍在处理中…',
    'bridge.st.success': '跨链完成',
    'bridge.st.failure': '跨链失败',
    'bridge.st.refund': '无法完成 — 资金已退回',

    /* ---- referral ---- */
    'ref.eyebrow': '推荐',
    'ref.title': '通过推荐赚取收益。',
    'ref.blurb': '你推荐的每一位用户，其 {fee} 提取手续费中的 {share} 归你所有。对方存入时奖励即时到账。',
    'ref.yourLink': '你的推荐链接',
    'ref.customRate': '专属费率',
    'ref.connectNote': '连接钱包以创建推荐码。',
    'ref.active': '已启用',
    'ref.codeNote':
      '任何通过此链接进入并存入的用户都会计入你的推荐。每个钱包会绑定其首次存入时的推荐人，该归属之后无法被他人抢走。',
    'ref.pick': '设置一个推荐码。无需 gas，只需签署一条消息。',
    'ref.placeholder': '自定义推荐码（可选）',
    'ref.create': '创建推荐码',
    'ref.creating': '创建中…',
    'ref.errCode': '3–20 位字母、数字、短横线或下划线',
    'ref.errLoad': '无法加载推荐数据',
    'ref.errCreate': '无法创建该推荐码',
    'ref.statEarned': '已赚取',
    'ref.statPartial': '部分数据 — 有资产尚未计价',
    'ref.statVolume': '存入总额',
    'ref.statDeposits': '存入笔数',
    'ref.statWallets': '钱包数',
    'ref.tableTitle': '推荐的存入记录',
    'ref.tableEmpty': '暂无记录。分享你的链接 — 存入交易获得足够确认后即会出现。',
    'ref.colWallet': '钱包',
    'ref.colDeposit': '存入',
    'ref.colCut': '你的分成',
    'ref.atRate': '按 {rate}',
    'ref.share': '分享到 X',
    'ref.shareText': '我在 Sherwood 上进行隐私交易。使用我的链接：',
    'ref.heroKicker': '邀请好友，每笔存入都有收益',
    'ref.yourCut': '你的分成',
    'ref.ofFee': '提取手续费',
    'ref.noCodeYet': '尚未创建推荐码',
    'ref.emptyCta': '分享你的链接即可开始。',
    'ref.copy': '复制',
    'ref.copied': '已复制',

    /* ---- first-run tour (lib/tour.ts) ---- */
    'tour.next': '下一步',
    'tour.prev': '上一步',
    'tour.done': '知道了',
    'tour.skip': '跳过导览',
    'tour.progress': '{{current}} / {{total}}',
    'tour.replay': '使用教程',
    'tour.welcome.title': '欢迎来到 Sherwood',
    'tour.welcome.body':
      'Sherwood 是一个由零知识证明驱动的链上隐私协议。把资金存入隐私池、私密地兑换，再提取到一个全新的钱包 —— 存入与提取之间不会产生直接的链上关联。',
    'tour.deposit.title': '存入',
    'tour.deposit.body':
      '存入会把钱包里的 ETH、USDG 或 SHERWOOD 转入金库，并换给你一笔只有你的密钥才能花费的隐私余额。这是与提取并列的唯一公开步骤 —— 一旦完成存入，你在金库内的其余操作都是私密的。',
    'tour.swap.title': '兑换',
    'tour.swap.body':
      '通过 Uniswap 兑换你的隐私余额，资金全程不离开金库。选择代币、输入数量、设置滑点即可。交易与 gas 都由中继器处理，兑换所得会作为一笔新的隐私余额回到你手中。',
    'tour.withdraw.title': '提取',
    'tour.withdraw.body':
      '提取可以把你的隐私余额发送到任意地址。交易与 gas 都由中继器处理，因此这次提取无法与你的存入关联起来。没有提走的部分会继续保持私密。',
    'tour.consolidate.title': '合并票据',
    'tour.consolidate.body':
      '你的余额不是一个数字，而是一堆票据 —— 每一次存入、兑换和找零都会产生一张。单次提取最多只能花掉其中两张，所以交易几次之后，你可能会看到「单次提取最多可发送 X」。这正是「合并票据」的用途：把多张票据合成更大的一张，让整笔余额可以一次性取出。它出现在提取页面，而且只在你确实需要时才出现。',
    'tour.positions.title': '我的持仓',
    'tour.positions.body':
      '本浏览器已知的全部隐私余额。用「+」按钮可以补上缺失的代币。<br><br>你存入或兑换得到的代币都保存在本地浏览器中。交易历史同样只存在本地，并且随时可以关闭。',
    'tour.import.title': '导入代币',
    'tour.import.body':
      '当你兑换得到一种代币时，Sherwood 会把该代币的信息保存在本地浏览器中。如果你清除了数据或更换了设备，这笔余额可能不再显示，但你的资金依然安全。只需导入该代币地址，就能重新找到并显示你的隐私余额。',
    'tour.referral.title': '推荐奖励',
    'tour.referral.body':
      '创建一个推荐码并分享你的链接。你推荐的用户产生的提取手续费，你都能分到一份，奖励自动发放。一个钱包一旦与你的推荐绑定，就会一直归属于你。',
    'tour.done.title': '整个应用就是这些。',
    'tour.done.body':
      '连接钱包并登录即可解锁兑换和提取。存入和跨链无需登录也能使用。<br><br>你随时可以点击页脚的「?」重看这个教程。',

    /* ---- progress (lib/actions.ts) ---- */
    'status.proving': '正在生成零知识证明…',
    'status.submittingDeposit': '正在提交存入交易…',
    'status.approving': '正在授权代币…',
    'status.signApproval': '请签署代币授权…',
    'status.signDeposit': '请签署存入交易…',
    'status.depositRelayer': '正在通过中继器提交存入交易…',
    'status.scanning': '正在扫描你的票据…',
    'status.consolidating': '正在合并你的票据…',
    'status.consolidatingStep': '正在合并你的票据（第 {step} 步）…',
    'status.relaying': '正在中继提取交易…',
    'status.relayingSwap': '正在中继兑换交易…',
    'status.findingPool': '正在寻找流动性最深的池子…',
  },
}

const isLang = (v: string | null): v is Lang => LANGS.some((l) => l.code === v)

const detect = (): Lang => {
  if (typeof window === 'undefined') return 'en'
  const stored = window.localStorage.getItem(STORAGE_KEY)
  if (isLang(stored)) return stored
  const nav = window.navigator.language.slice(0, 2).toLowerCase()
  return isLang(nav) ? nav : 'en'
}

export type Params = Record<string, string | number>

function fill(raw: string, params?: Params): string {
  if (!params) return raw
  return raw.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m))
}

function lookup(lang: Lang, key: string, params?: Params): string {
  return fill(STRINGS[lang][key] ?? STRINGS.en[key] ?? key, params)
}

// The language as a module-level value, kept in step with the provider below.
// Non-React code (lib/actions.ts and friends, which emit progress strings from
// outside any component) has no hook to reach for, so it translates through
// `tr`. Components must keep using `useI18n().t` — only that re-renders them
// when the language changes.
let active: Lang = detect()

/** Translate from outside React. See `active` above. */
export function tr(key: string, params?: Params): string {
  return lookup(active, key, params)
}

type Ctx = { lang: Lang; setLang: (l: Lang) => void; t: (key: string, params?: Params) => string }

const I18nContext = createContext<Ctx | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detect)

  useEffect(() => {
    document.documentElement.lang = lang
    active = lang
  }, [lang])

  const setLang = useCallback((l: Lang) => {
    // Set eagerly too: a `tr` call can happen before the effect above runs.
    active = l
    setLangState(l)
    try {
      window.localStorage.setItem(STORAGE_KEY, l)
    } catch {
      // private mode / storage disabled: the choice just won't persist
    }
  }, [])

  const t = useCallback((key: string, params?: Params) => lookup(lang, key, params), [lang])

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

/**
 * `t` for strings whose placeholders are React nodes — a number that has to stay
 * gold, a link inside a sentence. Filling those on the JS side would flatten them
 * to text; splitting the sentence around them would assume English word order,
 * which is exactly what a translation is free to change.
 */
export function T({ k, values }: { k: string; values?: Record<string, ReactNode> }) {
  const { lang } = useI18n()
  const raw = STRINGS[lang][k] ?? STRINGS.en[k] ?? k
  return (
    <>
      {raw.split(/(\{\w+\})/).map((part, i) => {
        const name = /^\{(\w+)\}$/.exec(part)?.[1]
        return name && values && name in values ? (
          <Fragment key={i}>{values[name]}</Fragment>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        )
      })}
    </>
  )
}

export function useI18n(): Ctx {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used inside <I18nProvider>')
  return ctx
}
