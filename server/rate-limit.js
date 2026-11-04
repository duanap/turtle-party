export class SlidingLimiter {
  constructor() {this.buckets=new Map();}
  check(key, max, windowMs=60000, now=Date.now()) {
    const entries=(this.buckets.get(key)||[]).filter(t=>t>now-windowMs);
    if(entries.length>=max) {
      this.buckets.set(key,entries);
      return false;
    }
    entries.push(now);this.buckets.set(key,entries);
    return true;
  }
  cleanup(now=Date.now()) {
    for(const [key,times] of this.buckets) {
      const active=times.filter(t=>t>now-60000);
      if(active.length) this.buckets.set(key,active);
      else this.buckets.delete(key);
    }
  }
}
