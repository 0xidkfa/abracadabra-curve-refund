import _ = require('underscore');
import { ethers, BigNumber, providers } from 'ethers';

import cauldronAbi from './abis/cauldronv4.json';
import yBribeAbi from './abis/yBribe.json';
import gaugeControllerAbi from './abis/gaugeController.json';
import gaugeDepositAbi from './abis/gaugeDeposit.json';
import veCrvAbi from './abis/veCrv.json';
import * as utils from './utils';
import moment = require('moment-timezone');

const SPELL_ADDR = '0x090185f2135308bad17527004364ebcc2d37e5f6';
const MIM_CAULDRON_ADDR = '0x207763511da879a900973A5E092382117C3c1588';
const YBRIBE_V2_ADDR = '0x7893bbb46613d7a4FbcC31Dab4C9b823FfeE1026';
const YBRIBE_V3_ADDR = '0x03dFdBcD4056E2F92251c7B07423E1a33a7D3F6d';
const CURVE_MIM_GAUGE_ADDR = '0xd8b712d29381748db89c36bca0138d7c75866ddf';
const CURVE_GAUGE_CONTROLLER_ADDR = '0x2F50D538606Fa9EDD2B11E2446BEb18C9D5846bB';
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

export class RefundCalculatorv2 {
  borrowAddr: string;
  votingAddr: string;
  provider: ethers.providers.JsonRpcProvider;
  cauldronContract: ethers.Contract;
  gaugeControllerContract: ethers.Contract;
  veCrvContract: ethers.Contract;
  gaugeDepositContract: ethers.Contract;
  yBribeContract: ethers.Contract;

  constructor(borrowAddr: string, votingAddr: string) {
    this.borrowAddr = borrowAddr;
    this.votingAddr = votingAddr;
    this.provider = new ethers.providers.AlchemyProvider('mainnet', '5GbPhhJvIkJhTU3Yo3d2ltnU0B9UX4nG');
    this.cauldronContract = new ethers.Contract(MIM_CAULDRON_ADDR, cauldronAbi, this.provider);
    this.gaugeDepositContract = new ethers.Contract(CURVE_MIM_GAUGE_ADDR, gaugeDepositAbi, this.provider);
    this.gaugeControllerContract = new ethers.Contract(CURVE_GAUGE_CONTROLLER_ADDR, gaugeControllerAbi, this.provider);
    this.veCrvContract = new ethers.Contract(VE_CRV_ADDR, veCrvAbi, this.provider);
    this.yBribeContract = new ethers.Contract(YBRIBE_V2_ADDR, yBribeAbi, this.provider);
  }

  // Get final refund amount, in dollars, based on spellPrice. spellPrice has 8 decimals (e.g., $0.00010000 is represented as 10000).
  async getRefundAmount(spellPrice: BigNumber): Promise<BigNumber> {
    const maxWeeklyRefund = await this.maxWeeklyRefund();
    const getVoterSpellBribesDollarValue = await this.getVoterSpellBribesDollarValue(spellPrice);
    return maxWeeklyRefund.gt(0) ? maxWeeklyRefund : getVoterSpellBribesDollarValue;
  }

  // Get SPELL amount to be sent back to Abracadabra treasury.
  async spellToBeReturned(spellPrice: BigNumber): Promise<BigNumber> {
    let refundAmount = await this.getRefundAmount(spellPrice);
    return refundAmount.mul(bnDecimals(8)).div(spellPrice);
  }

  // Get total borrow on CRV cauldron.
  async getTotalBorrow(): Promise<{ elastic: BigNumber; base: BigNumber }> {
    const total = await this.cauldronContract.totalBorrow();
    return total;
  }

  // Get user borrow part on CRV cauldron.
  async getUserBorrowPart(): Promise<BigNumber> {
    const userBorrowPart = await this.cauldronContract.userBorrowPart(this.borrowAddr);
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
    let slopes = await this.gaugeControllerContract.vote_user_slopes(addr, CURVE_MIM_GAUGE_ADDR);
    return slopes.power;
  }

  // Get the total veCrv balance of a voter.
  async getVoterVeCrv(addr: string): Promise<BigNumber> {
    return await this.veCrvContract.balanceOf(addr);
  }

  // Get % of veCrv votes that a user allocated to the MIM Gauge.
  async getVoterMimGaugeVotes(): Promise<BigNumber> {
    let voterVeCrv = await this.getVoterVeCrv(this.votingAddr);
    let mimGaugePower = await this.getVoterMimGaugePower(this.votingAddr);
    return voterVeCrv.mul(mimGaugePower).div(10000);
  }

  // Get the total MIM gauge votes received.
  async getTotalMimGaugeVotes(): Promise<BigNumber> {
    return await this.gaugeControllerContract.get_gauge_weight(CURVE_MIM_GAUGE_ADDR);
  }

  // Calculate the amount of SPELL bribes a voter will receive for that week.
  async getVoterSpellBribes(blockNum?: number): Promise<BigNumber> {
    const totalMimGaugeVotes = await this.getTotalMimGaugeVotes();
    const voterMimGaugeVotes = await this.getVoterMimGaugeVotes();
    return (await this.getWeeklySpellBribes(blockNum)).mul(voterMimGaugeVotes).div(totalMimGaugeVotes);
  }

  // Calculate the dollar value of SPELL bribes a voter will receive for that week.
  async getVoterSpellBribesDollarValue(spellPrice: BigNumber): Promise<BigNumber> {
    const voterSpellBribes = await this.getVoterSpellBribes();
    return voterSpellBribes.mul(spellPrice).div(bnDecimals(8));
  }

  async getWeeklySpellBribes(blockNum?: number): Promise<BigNumber> {
    // Get the total amount of rewards available for yBribers. This includes rollover from previous week.
    return (await this.rewardsPerGauge(blockNum)).sub(await this.claimsPerGauge(blockNum));
  }

  async rewardsPerGauge(blockNum?: number) {
    return await this.yBribeContract.reward_per_token(
      '0xd8b712d29381748db89c36bca0138d7c75866ddf',
      '0x090185f2135308bad17527004364ebcc2d37e5f6',
      { blockTag: blockNum || 'latest' }
    );
  }

  async claimsPerGauge(blockNum?: number) {
    return await this.yBribeContract.claims_per_gauge(
      '0xd8b712d29381748db89c36bca0138d7c75866ddf',
      '0x090185f2135308bad17527004364ebcc2d37e5f6',
      { blockTag: blockNum || 'latest' }
    );
  }
}

async function main() {
  let calc = new RefundCalculatorv2(
    '0x7a16ff8270133f063aab6c9977183d9e72835428',
    '0x9B44473E223f8a3c047AD86f387B80402536B029'
  );

  // const spellPrice = BigNumber.from(53604); // $0.00053604
  // console.log('Borrow amount ($):', formatBn(await calc.getBorrowAmount(), 18, 2));
  // console.log('Total veCRV voted (veCRV): ', formatBn(await calc.getVoterMimGaugeVotes(), 18, 2));
  // console.log('Total bribes received ($): ', formatBn(await calc.getVoterSpellBribesDollarValue(spellPrice), 18, 2));
  // console.log('Max weekly refund amount ($): ', formatBn(await calc.maxWeeklyRefund(), 18, 2));
  // console.log('Total refund amount ($): ', formatBn(await calc.getRefundAmount(spellPrice), 18, 2));
  // console.log('Total SPELL to return: ', formatBn(await calc.spellToBeReturned(spellPrice), 18, 2));

  let blocks = [
    12917419, 12961718, 13006976, 13052295, 13097628, 13142883, 13188218, 13233404, 13278687, 13323753, 13368530,
    // 13413050, 13457639, 13502421, 13546975, 13591594, 13636022, 13680219, 13724084, 13767793, 13812868, 13858107,
    // 13903355, 13948582, 13993833, 14039104, 14084333, 14129717, 14174989, 14220269, 14265472, 14310658, 14355748,
    // 14400649, 14445661, 14490620, 14535425, 14580220, 14625067, 14669558, 14713964, 14757896, 14801796, 14844802,
    // 14887797, 14929561, 14970303, 15010211, 15047599, 15092101, 15137389, 15182614, 15227621, 15272548, 15317426,
    // 15361719, 15405908, 15449618, 15493291, 15535777, 15585173, 15635279, 15685344, 15735471, 15785590, 15835687,
    // 15885773, 15935900, 15986020, 16036116, 16086234, 16136270, 16186378, 16236514, 16286697, 16336871,
  ];

  let provider = new ethers.providers.AlchemyProvider('mainnet', '5GbPhhJvIkJhTU3Yo3d2ltnU0B9UX4nG');

  for (let block of blocks) {
    try {
      let blockInfo = await provider.getBlock(block);
      let bribes = await calc.rewardsPerGauge(block);
      console.log(moment.utc(blockInfo.timestamp * 1000).format('YYYY-MM-DD'), block, bribes.toString());
    } catch (e) {
      console.log('Errored out', e, block);
    }
  }
}

main();
