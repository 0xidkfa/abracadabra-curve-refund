import 'mocha';
import { expect } from 'chai';
import { findThursdayAfter } from '../src/utils';

describe('utils', () => {
  describe('#findThursdayAfter', () => {
    it('should return the next Thursday after a given date', () => {
      expect(findThursdayAfter('2022-12-28')).to.deep.equal(new Date('2022-12-29T00:00:00.000Z'));
      expect(findThursdayAfter('2023-01-04')).to.deep.equal(new Date('2023-01-05T00:00:00.000Z'));
    });

    it('should return the next week Thursday if given a Thursday', () => {
      expect(findThursdayAfter('2023-01-05T00:00:00')).to.deep.equal(new Date('2023-01-12T00:00:00.000Z'));
    });

    it('should return the next Thursday even at the end of the year', () => {
      expect(findThursdayAfter('2022-12-30')).to.deep.equal(new Date('2023-01-05T00:00:00.000Z'));
      expect(findThursdayAfter('2022-12-31')).to.deep.equal(new Date('2023-01-05T00:00:00.000Z'));
    });
  });
});
