import { providers } from 'ethers';
import moment = require('moment-timezone');

export function findThursdayAfter(inputDate: string) {
  let date = moment.utc(inputDate);

  if (date.day() < 4) {
    return date.day(4).toDate();
  } else {
    return date.day(11).toDate();
  }
}

export async function findClosestBlock(time: number) {
  // Set up provider to connect to an Ethereum node
  const provider = new providers.JsonRpcProvider('https://eth.llamarpc.com');

  // Get the current block number
  const currentBlockNumber = await provider.getBlockNumber();

  // Set the initial lower bound and upper bound for the binary search
  let lowerBound = 0;
  let upperBound = currentBlockNumber;

  // Set a flag to indicate if the target block has been found
  let found = false;

  // Loop until the target block is found
  while (!found) {
    // Calculate the middle block number
    const middleBlockNumber = Math.floor((lowerBound + upperBound) / 2);

    // Get the block at the middle block number
    const block = await provider.getBlock(middleBlockNumber);
    // console.log('Block number:', block.number, 'Block timestamp:', block.timestamp);

    // Check if the block time is after the target time
    if (block.timestamp > time) {
      // If the block time is after the target time, set the upper bound to the middle block number
      upperBound = middleBlockNumber;
    } else {
      // If the block time is not after the target time, set the lower bound to the middle block number
      lowerBound = middleBlockNumber;
    }

    // Check if the lower bound and upper bound have converged
    if (lowerBound + 1 >= upperBound) {
      // If the lower bound and upper bound have converged, set the flag to true to stop the loop
      found = true;
    }
  }

  console.log(time, upperBound);
  // Return the block number of the closest block after the target time
  return upperBound;
}
