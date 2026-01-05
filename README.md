# Meme评分器

Solana Meme币快速评估工具，帮助你在内盘交易中快速判断是否值得买入。

## 功能

- **综合评分** - 0-100分快速判断
- **持仓分布分析** - Top10持仓占比、最大单持仓
- **砸盘风险模拟** - 模拟不同比例抛压对价格的影响
- **聪明钱检测** - 检测已知高胜率钱包是否持有
- **合约安全检查** - Mint/Freeze权限检查

## 安装

```bash
npm install
```

## 配置

复制 `.env.example` 为 `.env` 并填入你的API Key：

```bash
cp .env.example .env
```

编辑 `.env`：
```
HELIUS_API_KEY=your_helius_api_key_here
PORT=3000
```

## 运行

```bash
npm start
```

访问 http://localhost:3000

## 聪明钱列表

编辑 `smartMoney.json` 添加你收集的聪明钱地址。

## 数据源

- **Helius** - 代币信息、持仓分布
- **DexScreener** - 价格、流动性、交易量
- **GMGN** - 聪明钱标签（可选）
