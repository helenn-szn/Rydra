// Driver types. Same safety rules for everyone; what changes is the shape of the work.
'use strict';

const PROFILES = {
  bus: { id: 'bus', mode: 'trip', icon: 'bus' },        // long-distance bus or coach: one long trip
  cab: { id: 'cab', mode: 'shift', icon: 'cab' },       // taxi or ride-hail: many short trips in a shift
  private: { id: 'private', mode: 'trip', icon: 'car' }, // private car owner: occasional trips
};

const getProfile = (id) => PROFILES[id] || PROFILES.private;

module.exports = { PROFILES, getProfile };
