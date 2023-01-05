import _ = require('underscore');
import { ethers, BigNumber } from 'ethers';

import cauldronAbi from './abis/cauldronv4.json';
import gaugeControllerAbi from './abis/gaugeController.json';
import gaugeDepositAbi from './abis/gaugeDeposit.json';
import veCrvAbi from './abis/veCrv.json';

const MIM_CAULDRON_ADDR = '0x207763511da879a900973A5E092382117C3c1588';
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

export class RefundCalculator {
  borrowAddr: string;
  votingAddr: string;
  provider: ethers.providers.JsonRpcProvider;
  cauldronContract: ethers.Contract;
  gaugeControllerContract: ethers.Contract;
  veCrvContract: ethers.Contract;
  gaugeDepositContract: ethers.Contract;

  constructor(borrowAddr: string, votingAddr: string) {
    this.borrowAddr = borrowAddr;
    this.votingAddr = votingAddr;
    this.provider = new ethers.providers.JsonRpcProvider('https://eth.llamarpc.com');
    this.cauldronContract = new ethers.Contract(MIM_CAULDRON_ADDR, cauldronAbi, this.provider);
    this.gaugeDepositContract = new ethers.Contract(CURVE_MIM_GAUGE_ADDR, gaugeDepositAbi, this.provider);
    this.gaugeControllerContract = new ethers.Contract(CURVE_GAUGE_CONTROLLER_ADDR, gaugeControllerAbi, this.provider);
    this.veCrvContract = new ethers.Contract(VE_CRV_ADDR, veCrvAbi, this.provider);
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
  async getVoterSpellBribes(): Promise<BigNumber> {
    const totalMimGaugeVotes = await this.getTotalMimGaugeVotes();
    const voterMimGaugeVotes = await this.getVoterMimGaugeVotes();
    return WEEKLY_SPELL_BRIBE.mul(voterMimGaugeVotes).div(totalMimGaugeVotes);
  }

  // Calculate the dollar value of SPELL bribes a voter will receive for that week.
  async getVoterSpellBribesDollarValue(spellPrice: BigNumber): Promise<BigNumber> {
    const voterSpellBribes = await this.getVoterSpellBribes();
    return voterSpellBribes.mul(spellPrice).div(bnDecimals(8));
  }
}

async function main() {
  let calc = new RefundCalculator(
    '0x7a16ff8270133f063aab6c9977183d9e72835428',
    '0x9B44473E223f8a3c047AD86f387B80402536B029'
  );

  const spellPrice = BigNumber.from(53604); // $0.00053604

  console.log('Borrow amount ($):', formatBn(await calc.getBorrowAmount(), 18, 2));
  console.log('Total bribes received ($): ', formatBn(await calc.getVoterSpellBribesDollarValue(spellPrice), 18, 2));
  console.log('Max weekly refund amount ($): ', formatBn(await calc.maxWeeklyRefund(), 18, 2));
  console.log('Total refund amount ($): ', formatBn(await calc.getRefundAmount(spellPrice), 18, 2));
  console.log('Total SPELL to return: ', formatBn(await calc.spellToBeReturned(spellPrice), 18, 2));
}

main();
