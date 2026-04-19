# CCA Derivatives Desk

California Carbon Allowances options and futures pricing tool.

## Features
- Futures curve: Apr-26 → Dec-27, piecewise quarterly carry rates
- Options chain: Black-Scholes pricing for strikes $15–$50
- Quarterly expiries: Jun-26, Sep-26, Dec-26, Mar-27, Jun-27, Sep-27, Dec-27
- Vol surface: ATM vol, skew, and convexity sliders + per-strike fine-tuning
- Greeks: Delta, Gamma, Theta, Vega

## Local development

```bash
npm install
npm start
```

Opens at http://localhost:3000

## Deploy to Vercel

Push this repo to GitHub, then import at vercel.com. Vercel auto-detects Create React App and deploys with zero config.
