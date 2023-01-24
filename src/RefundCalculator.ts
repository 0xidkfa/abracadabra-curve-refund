import _ = require('underscore');
import { ethers, BigNumber, providers } from 'ethers';

import cauldronAbi from './abis/cauldronv4.json';
import yBribeAbi from './abis/yBribe.json';
import gaugeControllerAbi from './abis/gaugeController.json';
import gaugeDepositAbi from './abis/gaugeDeposit.json';
import veCrvAbi from './abis/veCrv.json';
import spellOracleAbi from './abis/oracle.json';
import * as utils from './utils';
import moment = require('moment-timezone');

const SPELL_ADDR = '0x090185f2135308bad17527004364ebcc2d37e5f6';
const MIM_CAULDRON_ADDR = '0x207763511da879a900973A5E092382117C3c1588';
const YBRIBE_V2_ADDR = '0x7893bbb46613d7a4FbcC31Dab4C9b823FfeE1026';
const YBRIBE_V3_ADDR = '0x03dFdBcD4056E2F92251c7B07423E1a33a7D3F6d';
const CURVE_MIM_GAUGE_ADDR = '0xd8b712d29381748db89c36bca0138d7c75866ddf';
const CURVE_GAUGE_CONTROLLER_ADDR = '0x2F50D538606Fa9EDD2B11E2446BEb18C9D5846bB';
const SPELL_ORACLE_ADDR = '0x75e14253dE6a5c2af12d5f1a1EA0A2E11e69EC10';
const VE_CRV_ADDR = '0x5f3b5DfEb7B28CDbD7FAba78963EE202a494e2A2';
const MAX_REFUND_RATE = 700; // 18% - 11%
const WEEKS_IN_YEAR = 52;
const WEEKLY_SPELL_BRIBE = BigNumber.from(134_193_798).mul(bnDecimals(18));

function bnDecimals(decimals: number): BigNumber {
  return BigNumber.from(10).pow(decimals);
}

function formatBn(number: BigNumber, decimals: number, displayDecimals: number): string {
  return (number.div(bnDecimals(decimals - displayDecimals)).toNumber() / Math.pow(10, displayDecimals)).toFixed(
    displayDecimals
  );
}

export class RefundCalculator {
  blockNumber: number | string;
  borrowAddr: string;
  votingAddr: string;
  provider: ethers.providers.JsonRpcProvider;
  cauldronContract: ethers.Contract;
  gaugeControllerContract: ethers.Contract;
  veCrvContract: ethers.Contract;
  gaugeDepositContract: ethers.Contract;
  yBribeContract: ethers.Contract;
  spellOracleContract: ethers.Contract;

  constructor(borrowAddr: string, votingAddr: string, blockNumber?: number) {
    this.blockNumber = blockNumber || 'latest';
    this.borrowAddr = borrowAddr;
    this.votingAddr = votingAddr;

    this.provider = new ethers.providers.AlchemyProvider('mainnet', '5GbPhhJvIkJhTU3Yo3d2ltnU0B9UX4nG');
    // this.provider = new ethers.providers.JsonRpcProvider(
    //   'https://rpc.tenderly.co/fork/a66c1c98-5eef-4381-8c3f-25a5fa306393'
    // );
    this.cauldronContract = new ethers.Contract(MIM_CAULDRON_ADDR, cauldronAbi, this.provider);
    this.gaugeDepositContract = new ethers.Contract(CURVE_MIM_GAUGE_ADDR, gaugeDepositAbi, this.provider);
    this.gaugeControllerContract = new ethers.Contract(CURVE_GAUGE_CONTROLLER_ADDR, gaugeControllerAbi, this.provider);
    this.veCrvContract = new ethers.Contract(VE_CRV_ADDR, veCrvAbi, this.provider);
    this.yBribeContract = new ethers.Contract(YBRIBE_V3_ADDR, yBribeAbi, this.provider);
    this.spellOracleContract = new ethers.Contract(SPELL_ORACLE_ADDR, spellOracleAbi, this.provider);
  }

  // Get final refund amount, in dollars, based on spellPrice. spellPrice has 8 decimals (e.g., $0.00010000 is represented as 10000).
  async getRefundAmount(spellPrice: BigNumber): Promise<BigNumber> {
    const maxWeeklyRefund = await this.maxWeeklyRefund();
    const getVoterSpellBribesDollarValue = await this.getVoterSpellBribesDollarValue(spellPrice);
    return maxWeeklyRefund.gt(getVoterSpellBribesDollarValue) ? getVoterSpellBribesDollarValue : maxWeeklyRefund;
  }

  // Get SPELL amount to be sent back to Abracadabra treasury.
  async spellToBeReturned(spellPrice: BigNumber): Promise<BigNumber> {
    let refundAmount = await this.getRefundAmount(spellPrice);
    return refundAmount.mul(bnDecimals(18)).div(spellPrice);
  }

  // Get total borrow on CRV cauldron.
  async getTotalBorrow(): Promise<{ elastic: BigNumber; base: BigNumber }> {
    const total = await this.cauldronContract.totalBorrow({ blockTag: this.blockNumber });
    return total;
  }

  // Get user borrow part on CRV cauldron.
  async getUserBorrowPart(): Promise<BigNumber> {
    const userBorrowPart = await this.cauldronContract.userBorrowPart(this.borrowAddr, { blockTag: this.blockNumber });
    return userBorrowPart;
  }

  // Get user borrow amount on CRV cauldron.
  async getBorrowAmount(): Promise<BigNumber> {
    const totalBorrow = await this.getTotalBorrow();
    const userBorrowPart = await this.getUserBorrowPart();
    return userBorrowPart.mul(totalBorrow.elastic).div(totalBorrow.base);
  }

  // Calculate the max weekly refund in dollars based on starting interest rate (18%) and minimum interest rate (11%).
  async maxWeeklyRefund(): Promise<BigNumber> {
    return (await this.getBorrowAmount()).mul(MAX_REFUND_RATE).div(10000).div(WEEKS_IN_YEAR);
  }

  // Get MIM gauge power of a voter. Power represents % of veCrv balance applied to gauge.
  async getVoterMimGaugePower(addr: string): Promise<BigNumber> {
    let slopes = await this.gaugeControllerContract.vote_user_slopes(addr, CURVE_MIM_GAUGE_ADDR, {
      blockTag: this.blockNumber,
    });
    return slopes.power;
  }

  // Get the total veCrv balance of a voter.
  async getVoterVeCrv(addr: string): Promise<BigNumber> {
    return await this.veCrvContract.balanceOf(addr, { blockTag: this.blockNumber });
  }

  // Get % of veCrv votes that a user allocated to the MIM Gauge.
  async getVoterMimGaugeVotes(): Promise<BigNumber> {
    let voterVeCrv = await this.getVoterVeCrv(this.votingAddr);
    let mimGaugePower = await this.getVoterMimGaugePower(this.votingAddr);
    return voterVeCrv.mul(mimGaugePower).div(10000);
  }

  // Get the total MIM gauge votes received.
  async getTotalMimGaugeVotes(): Promise<BigNumber> {
    return await this.gaugeControllerContract.get_gauge_weight(CURVE_MIM_GAUGE_ADDR, { blockTag: this.blockNumber });
  }

  // Calculate the amount of SPELL bribes a voter will receive for that week.
  async getVoterSpellBribes(): Promise<BigNumber> {
    const totalMimGaugeVotes = await this.getTotalMimGaugeVotes();
    const voterMimGaugeVotes = await this.getVoterMimGaugeVotes();
    const weeklySpellBribes = await this.getWeeklySpellBribes();

    return weeklySpellBribes.mul(voterMimGaugeVotes).div(totalMimGaugeVotes);
  }

  // Calculate the dollar value of SPELL bribes a voter will receive for that week.
  async getVoterSpellBribesDollarValue(spellPrice: BigNumber): Promise<BigNumber> {
    const voterSpellBribes = await this.getVoterSpellBribes();
    return voterSpellBribes.mul(spellPrice).div(bnDecimals(18));
  }

  async getWeeklySpellBribes(): Promise<BigNumber> {
    // Get the total amount of rewards available for yBribers. This includes rollover from previous week.
    return (await this.rewardsPerGauge()).sub(await this.claimsPerGauge());
  }

  async rewardsPerGauge() {
    return await this.yBribeContract.reward_per_gauge(CURVE_MIM_GAUGE_ADDR, SPELL_ADDR, { blockTag: this.blockNumber });
  }

  async claimsPerGauge() {
    return await this.yBribeContract.claims_per_gauge(CURVE_MIM_GAUGE_ADDR, SPELL_ADDR, { blockTag: this.blockNumber });
  }

  async getSpellPrice() {
    // Need to do 1 / price * 10^18 to get dollar value
    let spot = await this.spellOracleContract.peekSpot('0x00', { blockTag: this.blockNumber });
    return bnDecimals(36).div(spot);
  }
}

async function main() {
  let date = utils.findThursdayAfter('2023-01-18');
  // let blockNumber = await utils.findClosestBlock(date.getTime() / 1000);
  let blockNumber = 16437130;

  let calc = new RefundCalculator(
    '0x7a16ff8270133f063aab6c9977183d9e72835428',
    '0x9B44473E223f8a3c047AD86f387B80402536B029',
    blockNumber
  );

  console.log('As of: ', moment.utc(date.getTime()).toISOString());
  const spellPrice = await calc.getSpellPrice();
  console.log('SPELL price ($):', formatBn(spellPrice, 18, 6));
  console.log('Borrow amount ($):', formatBn(await calc.getBorrowAmount(), 18, 2));
  console.log('Total veCRV voted (veCRV): ', formatBn(await calc.getVoterMimGaugeVotes(), 18, 2));
  console.log('Total bribes received ($): ', formatBn(await calc.getVoterSpellBribesDollarValue(spellPrice), 18, 2));
  console.log('Max weekly refund amount ($): ', formatBn(await calc.maxWeeklyRefund(), 18, 2));
  console.log('Total refund amount ($): ', formatBn(await calc.getRefundAmount(spellPrice), 18, 2));
  console.log('Total SPELL to return: ', formatBn(await calc.spellToBeReturned(spellPrice), 18, 2));
}

main();
