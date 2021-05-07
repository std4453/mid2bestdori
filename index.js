const fs = require('fs');
const MIDIFile = require('midifile');

const input = fs.readFileSync("/mnt/c/Users/std4453/OneDrive/202104/fenix.mid");
const parsed = new MIDIFile(input);

const colorToType = {
    0: 'slide/A',
    1: 'slide/B',
    4: 'tap',
    5: 'slideTap/A',
    6: 'slideTap/B',
    8: 'flick',
    9: 'slideFlick/A',
    10: 'slideFlick/B',
};
const pitchToLane = {
    36: 7,
    37: 6,
    38: 5,
    39: 4,
    40: 3,
    41: 2,
    42: 1,
};

// iterate over midi events to get notes 
const noteMap = {};
const notes = [];
let lastTime = 0;
for (const {
    delta,              // time delta from last event, in ticks
    subtype,            // 9 for noteOn, 8 for noteOff
    channel: color,
    param1: pitch,
} of parsed.getMidiEvents()) {
    const type = colorToType[color];
    const lane = pitchToLane[pitch];
    // use tick number to keep as integer
    const time = lastTime + delta;
    // whatever happens after, lastTime must be accumulated
    lastTime += delta;
    const on = subtype === 9;

    // MIDI events come in ons and offs, while an off event doesn't
    // provide the index of the corresponding on event, so we have
    // to do that ourselves to know when exactly each note start and
    // stop
    // from observations, notes with same color on same lane don't
    // overlap from one another so we can always expect a direct off
    // event after an on event, given that the lane and color is the
    // same
    const noteMapKey = `${lane}-${type}`;
    if (on) {
        if (noteMap[noteMapKey]) {
            console.warn(`overlay on lane ${lane} and type ${type} at time ${time}, discarding old note`);
        }
        noteMap[noteMapKey] = {
            startTime: time,
        };
    } else {
        if (!noteMap[noteMapKey]) {
            console.warn(`unpaired off event on lane ${lane} and type ${type} at time ${time}, discarding current event`);
            continue;
        }
        
        // extract note
        const note = noteMap[noteMapKey];
        delete noteMap[noteMapKey];
        note.endTime = time;
        note.duration = note.endTime - note.startTime;
        // we use type and lane as key so they must match
        note.type = type;
        note.lane = lane;

        // sanity checks
        if (note.duration < 0) {
            console.warn(`negative duration on laye ${lane} and type ${type} at time ${time}, discarding note`);
            continue;
        }
        // in this phase we don't distinguish between normal taps & flicks and slide ends
        if ((type === 'flick' || type === 'tap') && note.duration !== 0) {
            console.warn(`${type} note on lane ${lane} at time ${time} duration is not 0, discarding note`);
            continue;
        }
        if (type === 'slide' && note.duration === 0) {
            console.warn(`slide note on lane ${lane} at time ${time} duration is 0, discarding note`);
            continue;
        }
        
        notes.push(note);
    }
}
// sanity check
for (const key in noteMap) {
    if (Boolean(noteMap[key])) {
        console.warn(`key ${key} in noteMap is not clear`);
    }
}
// sort notes by startTime
notes.sort(({ startTime: t1 }, { startTime: t2 }) => t1 - t2);

// next we convert notes to bestdori format
const out = [];
const slideMap = {
    A: null,
    B: null,
};
const bpm = 180;
// offset of score relative to the music, in beats
// positive means that the score begins later than the music
const offset = 4 /* steps */ / 4 /* steps-per-beat */; 
// beats = ticks (startTime & endTime) / tpb
const tpb = parsed.header.getTicksPerBeat();
// add BPM event
out.push({
    type: "System",
    cmd: "BPM",
    beat: 0,
    bpm,
});
for (const note of notes) {
    const { type, lane, startTime } = note;
    const beat = startTime / tpb + offset;
    // A or B or whole string (if not slide-related)
    const pos = type.substring(type.lastIndexOf("/") + 1);
    const time = `${(beat / bpm * 60).toFixed(2)}s`;
    switch (type) {
        case "tap":
            out.push({
                type: "Note",
                lane,
                beat, 
                note: "Single",
            });
            break;
        case "flick": 
            out.push({
                type: "Note",
                lane,
                beat,
                note: "Single",
                flick: true,
            });
            break;
        case "slide/A":
        case "slide/B": 
            {
                // if slideMap[pos] is existant than it's not starting
                const start = !Boolean(slideMap[pos]);
                // slide notes should be adjacent to each other, so last
                // endTime should be identical to current startTime
                // if not, we show a warning since bestdori doesn't actually
                // need endTime for a slide note
                if (!start && slideMap[pos].endTime !== startTime) {
                    console.warn(`last slide note for pos ${pos} is not connected to current one at time ${time}, continuing`);
                }
                out.push({
                    type: "Note",
                    note: "Slide",
                    pos,
                    lane,
                    beat,
                    start,
                });
                // set current note in slideMap
                slideMap[pos] = note;
                break;
            }
        case "slideTap/A":
        case "slideTap/B":
        case "slideFlick/A":
        case "slideFlick/B":
            {
                const flick = type.indexOf("Flick") !== -1;
                // slide end should be after a slide note
                if (!slideMap[pos]) {
                    console.warn(`slide end note of type ${type} at time ${time} is not within a slide, discarding note`);
                    break;
                }
                // same as above
                if (slideMap[pos].endTime !== startTime) {
                    console.warn(`last slide note for pos ${pos} is not connected to current note of type ${type} at time ${time}, continuing`);
                }
                out.push({
                    type: "Note",
                    note: "Slide",
                    pos,
                    lane,
                    beat,
                    end: true,
                    flick
                });
                // clear slideMap since this slide have ended
                slideMap[pos] = null;
                break;
            }
    }
}
// sanity check
for (const key in slideMap) {
    if (Boolean(slideMap[key])) {
        console.warn(`pos ${key} in slideMap is not clear`)
    }
}

const text = JSON.stringify(out, true, 2);
fs.writeFileSync("output.json", text);