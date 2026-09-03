import assert from 'node:assert/strict';
import {
  classifyReplyIntent, replyReleaseVelocity, shouldCommitReply,
} from '../src/ui/swipeReplyCore';

assert.equal(classifyReplyIntent(9, 0), 'pending', 'movement below 10px remains undecided');
assert.equal(classifyReplyIntent(10, 2), 'drag', 'rightward horizontal movement commits at hysteresis');
assert.equal(classifyReplyIntent(2, 12), 'reject', 'vertical movement stays browser-owned');
assert.equal(classifyReplyIntent(-20, 1), 'reject', 'wrong-way movement never replies');
assert.equal(shouldCommitReply(56, [{ x: 0, time: 0 }, { x: 56, time: 300 }]), true, 'distance commits without a flick');
assert.equal(shouldCommitReply(20, [{ x: 0, time: 0 }, { x: 20, time: 20 }]), true, 'deliberate fast flick commits');
assert.equal(shouldCommitReply(17, [{ x: 0, time: 0 }, { x: 17, time: 10 }]), false, 'velocity alone cannot bypass minimum travel');
assert.equal(shouldCommitReply(70, [{ x: 0, time: 0 }, { x: 70, time: 50 }, { x: 30, time: 70 }]), false, 'final reversal cancels after crossing distance');
assert.equal(replyReleaseVelocity([{ x: 0, time: 0 }, { x: 20, time: 20 }, { x: 20, time: 25 }]), 800, 'same-coordinate pointer-up includes the brief hold in release velocity');
assert.equal(replyReleaseVelocity([{ x: 0, time: 0 }, { x: 20, time: 20 }, { x: 20, time: 200 }]), 0, 'a pause before release is not a flick');

console.log('swipe-reply-core OK — hysteresis, direction, distance, velocity, and reversal');
