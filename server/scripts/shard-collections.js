// Run in mongosh after configuring the cluster and enabling sharding on `seatspot`.
// The compound key preserves restaurant co-location while allowing documents to split.
const collections = ['users', 'restaurants', 'tables', 'bookings', 'queueentries'];
for (const collection of collections) {
  print(`sh.shardCollection('seatspot.${collection}', { restaurantId: 1, _id: 1 })`);
}
