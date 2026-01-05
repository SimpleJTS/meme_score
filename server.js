require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';
const PORT = process.env.PORT || 3000;

// 加载聪明钱地址列表
let smartMoneyAddresses = [];
try {
  const data = fs.readFileSync(path.join(__dirname, 'smartMoney.json'), 'utf8');
  smartMoneyAddresses = JSON.parse(data);
} catch (e) {
  console.log('聪明钱列表未找到，将使用空列表');
}

// ============ API路由 ============

// 主分析接口
app.get('/api/analyze/:ca', async (req, res) => {
  const { ca } = req.params;

  try {
    // 并行获取所有数据
    const [tokenInfo, dexData, holders, gmgnData] = await Promise.all([
      getTokenInfo(ca),
      getDexScreenerData(ca),
      getTopHolders(ca),
      getGMGNData(ca).catch(() => null)
    ]);

    if (!dexData) {
      return res.status(404).json({ error: '无法获取代币信息，请检查CA是否正确' });
    }

    // 如果没有Helius数据，用DexScreener的数据补充
    const finalTokenInfo = tokenInfo || {
      name: dexData.baseToken?.name || 'Unknown',
      symbol: dexData.baseToken?.symbol || 'Unknown',
      supply: dexData.baseToken?.totalSupply || 1000000000000000,
      decimals: 9,
      mintAuthority: null,
      freezeAuthority: null
    };

    // 分析持仓
    const holdersAnalysis = analyzeHolders(holders, finalTokenInfo.supply);

    // 检测聪明钱
    const smartMoneyAnalysis = analyzeSmartMoney(holders, gmgnData);

    // 计算评分
    const scores = calculateScores(holdersAnalysis, dexData, smartMoneyAnalysis, finalTokenInfo);

    // 计算砸盘模拟
    const dumpSimulation = calculateDumpSimulation(
      dexData.priceUsd,
      dexData.liquidity,
      holdersAnalysis,
      finalTokenInfo.supply
    );

    res.json({
      token: {
        name: finalTokenInfo.name,
        symbol: finalTokenInfo.symbol,
        ca: ca,
        supply: finalTokenInfo.supply,
        mintAuthority: finalTokenInfo.mintAuthority,
        freezeAuthority: finalTokenInfo.freezeAuthority
      },
      market: {
        price: dexData.priceUsd,
        priceNative: dexData.priceNative,
        marketCap: dexData.marketCap,
        liquidity: dexData.liquidity,
        volume24h: dexData.volume24h,
        priceChange24h: dexData.priceChange24h,
        pairAddress: dexData.pairAddress,
        dexId: dexData.dexId
      },
      holders: holdersAnalysis,
      smartMoney: smartMoneyAnalysis,
      scores: scores,
      dumpSimulation: dumpSimulation
    });

  } catch (error) {
    console.error('分析错误:', error);
    res.status(500).json({ error: '分析失败: ' + error.message });
  }
});

// ============ 数据获取函数 ============

// 获取代币基本信息 (Helius)
async function getTokenInfo(ca) {
  if (!HELIUS_API_KEY) {
    // 没有API Key时使用DexScreener的数据
    return null;
  }

  try {
    const response = await fetch(`https://api.helius.xyz/v0/token-metadata?api-key=${HELIUS_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mintAccounts: [ca] })
    });

    const data = await response.json();
    if (data && data[0]) {
      const token = data[0];
      return {
        name: token.onChainMetadata?.metadata?.data?.name || token.legacyMetadata?.name || 'Unknown',
        symbol: token.onChainMetadata?.metadata?.data?.symbol || token.legacyMetadata?.symbol || 'Unknown',
        supply: token.onChainMetadata?.metadata?.mint?.supply || 0,
        decimals: token.onChainMetadata?.metadata?.mint?.decimals || 9,
        mintAuthority: token.onChainMetadata?.metadata?.mint?.mintAuthority || null,
        freezeAuthority: token.onChainMetadata?.metadata?.mint?.freezeAuthority || null
      };
    }
  } catch (e) {
    console.error('Helius API错误:', e);
  }
  return null;
}

// 获取DexScreener数据
async function getDexScreenerData(ca) {
  try {
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${ca}`);
    const data = await response.json();

    if (data.pairs && data.pairs.length > 0) {
      // 找到流动性最高的交易对
      const pair = data.pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];

      return {
        priceUsd: parseFloat(pair.priceUsd) || 0,
        priceNative: parseFloat(pair.priceNative) || 0,
        marketCap: pair.marketCap || pair.fdv || 0,
        liquidity: pair.liquidity?.usd || 0,
        volume24h: pair.volume?.h24 || 0,
        priceChange24h: pair.priceChange?.h24 || 0,
        pairAddress: pair.pairAddress,
        dexId: pair.dexId,
        baseToken: pair.baseToken,
        quoteToken: pair.quoteToken
      };
    }
  } catch (e) {
    console.error('DexScreener API错误:', e);
  }
  return null;
}

// 获取Top持仓者 (Helius)
async function getTopHolders(ca) {
  if (!HELIUS_API_KEY) {
    return [];
  }

  try {
    const response = await fetch(`https://api.helius.xyz/v0/addresses/${ca}/balances?api-key=${HELIUS_API_KEY}`);

    // Helius的这个接口可能不是我们需要的，改用RPC
    const rpcResponse = await fetch(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTokenLargestAccounts',
        params: [ca]
      })
    });

    const rpcData = await rpcResponse.json();

    if (rpcData.result && rpcData.result.value) {
      // 获取每个token账户的owner
      const accounts = rpcData.result.value;
      const holdersWithOwner = await Promise.all(
        accounts.slice(0, 20).map(async (account) => {
          const ownerInfo = await getTokenAccountOwner(account.address);
          return {
            address: account.address,
            owner: ownerInfo,
            amount: account.amount,
            uiAmount: account.uiAmount,
            decimals: account.decimals
          };
        })
      );
      return holdersWithOwner;
    }
  } catch (e) {
    console.error('获取持仓者错误:', e);
  }
  return [];
}

// 获取Token账户的Owner
async function getTokenAccountOwner(tokenAccount) {
  if (!HELIUS_API_KEY) return null;

  try {
    const response = await fetch(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getAccountInfo',
        params: [tokenAccount, { encoding: 'jsonParsed' }]
      })
    });

    const data = await response.json();
    if (data.result?.value?.data?.parsed?.info?.owner) {
      return data.result.value.data.parsed.info.owner;
    }
  } catch (e) {
    console.error('获取Owner错误:', e);
  }
  return null;
}

// 获取GMGN数据（聪明钱等）
async function getGMGNData(ca) {
  try {
    const response = await fetch(`https://gmgn.ai/defi/quotation/v1/tokens/sol/${ca}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
      }
    });

    if (response.ok) {
      const data = await response.json();
      return data.data;
    }
  } catch (e) {
    console.error('GMGN API错误:', e);
  }
  return null;
}

// ============ 分析函数 ============

// 分析持仓分布
function analyzeHolders(holders, totalSupply) {
  if (!holders || holders.length === 0) {
    return {
      top10: [],
      top10Percent: 0,
      top5Percent: 0,
      maxHolderPercent: 0,
      devHolding: null,
      holderCount: 0
    };
  }

  const top10 = holders.slice(0, 10).map((h, index) => {
    const percent = totalSupply > 0 ? (h.uiAmount / (totalSupply / Math.pow(10, h.decimals || 9))) * 100 : 0;
    return {
      rank: index + 1,
      address: h.owner || h.address,
      tokenAccount: h.address,
      amount: h.uiAmount,
      percent: percent,
      isSmartMoney: smartMoneyAddresses.includes(h.owner)
    };
  });

  const top10Percent = top10.reduce((sum, h) => sum + h.percent, 0);
  const top5Percent = top10.slice(0, 5).reduce((sum, h) => sum + h.percent, 0);
  const maxHolderPercent = top10[0]?.percent || 0;

  return {
    top10: top10,
    top10Percent: top10Percent,
    top5Percent: top5Percent,
    maxHolderPercent: maxHolderPercent,
    devHolding: null, // 需要额外逻辑判断dev
    holderCount: holders.length
  };
}

// 分析聪明钱
function analyzeSmartMoney(holders, gmgnData) {
  const result = {
    count: 0,
    totalPercent: 0,
    holders: [],
    gmgnSmartMoney: null
  };

  // 从本地列表检测
  if (holders && holders.length > 0) {
    holders.forEach(h => {
      if (smartMoneyAddresses.includes(h.owner)) {
        result.count++;
        const percent = h.uiAmount ? (h.uiAmount / 1e9) * 100 : 0; // 简化计算
        result.totalPercent += percent;
        result.holders.push({
          address: h.owner,
          amount: h.uiAmount,
          percent: percent
        });
      }
    });
  }

  // 从GMGN数据补充
  if (gmgnData) {
    result.gmgnSmartMoney = {
      smartMoneyCount: gmgnData.smart_degen || 0,
      whaleCount: gmgnData.whale_count || 0
    };
    // 如果本地没检测到，用GMGN的数据
    if (result.count === 0 && gmgnData.smart_degen) {
      result.count = gmgnData.smart_degen;
    }
  }

  return result;
}

// ============ 评分计算 ============

function calculateScores(holdersAnalysis, dexData, smartMoneyAnalysis, tokenInfo) {
  // 1. 持仓安全分 (40分)
  let holdingScore = 0;

  // Top10持仓占比 (20分)
  const top10Percent = holdersAnalysis.top10Percent;
  if (top10Percent <= 15) holdingScore += 20;
  else if (top10Percent <= 30) holdingScore += 20 - (top10Percent - 15) * 0.8;
  else if (top10Percent <= 50) holdingScore += 8 - (top10Percent - 30) * 0.3;
  else holdingScore += 2;

  // 最大单持仓 (15分)
  const maxPercent = holdersAnalysis.maxHolderPercent;
  if (maxPercent <= 3) holdingScore += 15;
  else if (maxPercent <= 5) holdingScore += 12;
  else if (maxPercent <= 10) holdingScore += 8;
  else if (maxPercent <= 20) holdingScore += 4;
  else holdingScore += 0;

  // Dev持仓 (5分) - 暂时给默认分
  holdingScore += 3;

  // 2. 流动性分 (25分)
  let liquidityScore = 0;
  const liquidity = dexData.liquidity;

  // 流动性深度 (15分)
  if (liquidity >= 100000) liquidityScore += 15;
  else if (liquidity >= 50000) liquidityScore += 12;
  else if (liquidity >= 20000) liquidityScore += 9;
  else if (liquidity >= 10000) liquidityScore += 6;
  else if (liquidity >= 5000) liquidityScore += 3;
  else liquidityScore += 1;

  // 市值/流动性比 (10分)
  const mcapLiqRatio = dexData.marketCap / Math.max(liquidity, 1);
  if (mcapLiqRatio <= 5) liquidityScore += 10;
  else if (mcapLiqRatio <= 10) liquidityScore += 8;
  else if (mcapLiqRatio <= 20) liquidityScore += 5;
  else if (mcapLiqRatio <= 50) liquidityScore += 2;
  else liquidityScore += 0;

  // 3. 聪明钱分 (25分)
  let smartMoneyScore = 0;

  // 聪明钱数量 (15分)
  smartMoneyScore += Math.min(smartMoneyAnalysis.count * 3, 15);

  // 聪明钱持仓比例 (10分)
  const smPercent = smartMoneyAnalysis.totalPercent;
  if (smPercent >= 5) smartMoneyScore += 10;
  else if (smPercent >= 2) smartMoneyScore += 7;
  else if (smPercent >= 1) smartMoneyScore += 4;
  else if (smPercent > 0) smartMoneyScore += 2;

  // 4. 合约安全分 (10分)
  let safetyScore = 0;

  if (tokenInfo) {
    // Mint权限 (4分)
    if (!tokenInfo.mintAuthority) safetyScore += 4;

    // Freeze权限 (3分)
    if (!tokenInfo.freezeAuthority) safetyScore += 3;
  } else {
    // 没有token信息时给默认分
    safetyScore += 4;
  }

  // LP状态暂时给默认分 (3分)
  safetyScore += 2;

  const totalScore = Math.round(holdingScore + liquidityScore + smartMoneyScore + safetyScore);

  // 评级
  let rating, ratingText, ratingColor;
  if (totalScore >= 80) {
    rating = 'A';
    ratingText = '可以冲';
    ratingColor = '#22c55e';
  } else if (totalScore >= 60) {
    rating = 'B';
    ratingText = '谨慎买入';
    ratingColor = '#eab308';
  } else if (totalScore >= 40) {
    rating = 'C';
    ratingText = '风险较高';
    ratingColor = '#f97316';
  } else {
    rating = 'D';
    ratingText = '建议观望';
    ratingColor = '#ef4444';
  }

  return {
    total: totalScore,
    holding: Math.round(holdingScore),
    liquidity: Math.round(liquidityScore),
    smartMoney: Math.round(smartMoneyScore),
    safety: Math.round(safetyScore),
    rating: rating,
    ratingText: ratingText,
    ratingColor: ratingColor
  };
}

// ============ 砸盘模拟计算 ============

function calculateDumpSimulation(currentPrice, liquidity, holdersAnalysis, totalSupply) {
  // 估算池子中的token数量
  // 简化假设：流动性的一半是token价值
  const tokenValueInPool = liquidity / 2;
  const tokensInPool = tokenValueInPool / currentPrice;

  const simulations = [];

  // 场景1: Top1全砸
  if (holdersAnalysis.top10[0]) {
    const top1Percent = holdersAnalysis.top10[0].percent;
    const sellAmount = (totalSupply / 1e9) * (top1Percent / 100);
    const impact = calculatePriceImpact(sellAmount, tokensInPool);
    simulations.push({
      scenario: 'Top1全砸',
      sellPercent: top1Percent.toFixed(2),
      newPrice: currentPrice * (1 - impact),
      priceImpact: impact,
      impactPercent: (impact * 100).toFixed(2)
    });
  }

  // 场景2: Top5全砸
  const top5Percent = holdersAnalysis.top5Percent;
  if (top5Percent > 0) {
    const sellAmount = (totalSupply / 1e9) * (top5Percent / 100);
    const impact = calculatePriceImpact(sellAmount, tokensInPool);
    simulations.push({
      scenario: 'Top5全砸',
      sellPercent: top5Percent.toFixed(2),
      newPrice: currentPrice * (1 - impact),
      priceImpact: impact,
      impactPercent: (impact * 100).toFixed(2)
    });
  }

  // 场景3-5: 固定比例砸盘
  [5, 10, 20].forEach(percent => {
    const sellAmount = (totalSupply / 1e9) * (percent / 100);
    const impact = calculatePriceImpact(sellAmount, tokensInPool);
    simulations.push({
      scenario: `${percent}%抛压`,
      sellPercent: percent.toFixed(2),
      newPrice: currentPrice * (1 - impact),
      priceImpact: impact,
      impactPercent: (impact * 100).toFixed(2)
    });
  });

  return {
    currentPrice: currentPrice,
    estimatedPoolTokens: tokensInPool,
    simulations: simulations
  };
}

// AMM价格影响计算
function calculatePriceImpact(sellAmount, tokensInPool) {
  if (tokensInPool <= 0) return 0;

  // 恒定乘积公式: x * y = k
  // 价格影响 = 1 - (tokensInPool / (tokensInPool + sellAmount))^2
  const ratio = tokensInPool / (tokensInPool + sellAmount);
  const impact = 1 - Math.pow(ratio, 2);

  return Math.min(impact, 0.99); // 最大99%跌幅
}

// ============ 启动服务器 ============

app.listen(PORT, () => {
  console.log(`\n🚀 Meme评分器已启动`);
  console.log(`📍 访问地址: http://localhost:${PORT}`);
  console.log(`🔑 Helius API: ${HELIUS_API_KEY ? '已配置' : '未配置'}`);
  console.log(`📊 聪明钱地址数: ${smartMoneyAddresses.length}`);
  console.log('');
});
