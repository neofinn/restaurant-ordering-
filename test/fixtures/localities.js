'use strict';

// Chandigarh tricity localities (the places the tests send customers to).
const localities = [
  ['Sector 8', 'Chandigarh', 30.7410, 76.8010], ['Sector 9', 'Chandigarh', 30.7480, 76.7930],
  ['Sector 15', 'Chandigarh', 30.7520, 76.7680], ['Sector 17', 'Chandigarh', 30.7410, 76.7790],
  ['Sector 22', 'Chandigarh', 30.7330, 76.7720], ['Sector 26', 'Chandigarh', 30.7300, 76.8070],
  ['Sector 32', 'Chandigarh', 30.7150, 76.7780], ['Sector 35', 'Chandigarh', 30.7225, 76.7570],
  ['Sector 43', 'Chandigarh', 30.7180, 76.7400], ['Sector 44', 'Chandigarh', 30.7080, 76.7550],
  ['Industrial Area Phase 1', 'Chandigarh', 30.7050, 76.8000], ['Manimajra', 'Chandigarh', 30.7290, 76.8380],
  ['Phase 3B2', 'Mohali', 30.7230, 76.7120], ['Phase 5', 'Mohali', 30.7140, 76.7200],
  ['Phase 7', 'Mohali', 30.7085, 76.7195], ['Phase 10', 'Mohali', 30.6930, 76.7310],
  ['Sector 70', 'Mohali', 30.6990, 76.7140], ['Sector 82 (IT City)', 'Mohali', 30.6680, 76.7180],
  ['Kharar', 'Kharar', 30.7460, 76.6450], ['Landran', 'Kharar', 30.7020, 76.6630],
  ['Zirakpur VIP Road', 'Zirakpur', 30.6420, 76.8170], ['Dhakoli', 'Zirakpur', 30.6560, 76.8420],
  ['Sector 5', 'Panchkula', 30.6940, 76.8600], ['Sector 11', 'Panchkula', 30.6960, 76.8480],
  ['Sector 20', 'Panchkula', 30.6710, 76.8410], ['Sector 26', 'Panchkula', 30.6870, 76.8800],
  ['Mansa Devi', 'Panchkula', 30.7310, 76.8610], ['Chandimandir', 'Panchkula', 30.7220, 76.8850],
  ['Peer Muchalla', 'Zirakpur', 30.6720, 76.8450], ['Bhabat', 'Zirakpur', 30.6400, 76.8250],
  ['Aerocity', 'Mohali', 30.6630, 76.7330], ['Sohana', 'Mohali', 30.6830, 76.7000], ['TDI City', 'Mohali', 30.6480, 76.6900],
  ['Sunny Enclave', 'Kharar', 30.7350, 76.6600], ['New Chandigarh', 'Mullanpur', 30.7870, 76.6950],
  ['PGI', 'Chandigarh', 30.7650, 76.7760], ['IT Park', 'Chandigarh', 30.7270, 76.8450],
  ['Pinjore', 'Pinjore', 30.7970, 76.9170], ['Dera Bassi', 'Dera Bassi', 30.5880, 76.8430],
  ['Kurali', 'Kurali', 30.8360, 76.5740], ['Banur', 'Banur', 30.5560, 76.7160],
].map(([name, city, lat, lng]) => ({ name, city, lat, lng }));

module.exports = localities;
