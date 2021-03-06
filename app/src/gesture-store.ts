import { computed, observable, action } from "mobx";
import { Gesture, MotionReading, GestureExampleData, Match } from "./motion";
import { SingleDTWCore } from "./model";
import { serialData } from "./serial-data";


const READING_HISTORY_LIMIT = 30;

const createLowPassFilter = () => {
    const alpha = 0.5;
    let previousSmoothed = 0;
    return (value: number) => {
        const smoothed = alpha * value + (1 - alpha) * previousSmoothed;
        previousSmoothed = smoothed;
        return smoothed;
    }
}



export class GestureStore {
    // contains all of the gesture data
    @observable public gestures: Gesture[] = [];
    // is the Circuit Playground streaming accelerometer data or not
    @observable public connected: boolean;
    // needs saving
    @observable public hasBeenModified: boolean = false;
    @observable public readings: MotionReading[] = []; // 0 <= length < READING_HISTORY_LIMIT 
    @observable public latestTimestamp: number = 0;
    @observable public matches: Match[] = [];

    private models: SingleDTWCore[] = [];
    private idToType: pxt.Map<string> = {};
    private extId: string;
    private curGestureIndex: number = 0;

    public saveBlocks = debounce(() => this.saveBlocksNow(), 2000);


    constructor() {
        this.extId = window.location.hash.substr(1);
        console.log(`extension id: ${this.extId}`)

        window.addEventListener(
            "message",
            ev => ev.data.type == "pxtpkgext" ? this.receiveMessage(ev.data) : undefined,
            false);

        this.sendRequest("extinit");

        const filterX = createLowPassFilter();
        const filterY = createLowPassFilter();
        const filterZ = createLowPassFilter();

        serialData.register(data => {
            const accelX = filterX(data.accVec.accelX);
            const accelY = filterY(data.accVec.accelY);
            const accelZ = filterZ(data.accVec.accelZ);

            this.readings.push(new MotionReading(accelX, accelY, accelZ));
            this.latestTimestamp++;
            if (this.readings.length > READING_HISTORY_LIMIT) {
                this.readings.shift();
            }

            if (this.currentModel && this.currentModel.isRunning()) {
                let match = this.currentModel.feed(data.accVec);
                if (match) {
                    this.matches.push(match);
                }
            }
        });
    }


    public get readingLimit() { return READING_HISTORY_LIMIT; }


    @computed public get currentModel() {
        return this.models[this.curGestureIndex];
    }


    @computed public get currentGesture() {
        return this.gestures[this.curGestureIndex];
    }


    @computed public get currentOrientation() {
        return this.readings.length ?
            this.readings[this.readings.length - 1] :
            undefined;
    }


    public isMatch(readingIndex: number): boolean {
        const time = this.latestTimestamp - (this.readings.length - 1 - readingIndex);
        return this.matches.findIndex(m => m.startTime <= time && time <= m.endTime) >= 0;
    }


    @action public setCurrentGesture(gestureId: number): void {
        this.curGestureIndex = this.gestures.findIndex(g => g.gestureID === gestureId);
        this.currentModel.update(this.gestures[this.curGestureIndex].getCroppedData(), this.latestTimestamp);   
    }


    @action public deleteSample(gesture: Gesture, sample: GestureExampleData) {
        let cloneData = this.gestures.slice();
        const gi = this.gestures.indexOf(gesture);
        const si = this.gestures[gi].samples.indexOf(sample);

        cloneData[gi].samples.splice(si, 1);
        const model = this.models[gi];
        model.update(cloneData[gi].getCroppedData(), this.latestTimestamp);
        cloneData[gi].displayGesture = model.prototype;

        this.gestures = cloneData;
        this.markDirty();
    }


    @action public addSample(gesture: Gesture, newSample: GestureExampleData) {
        let cloneData = this.gestures.slice();
        const gestureIndex = this.gestures.indexOf(gesture);
        // do not change the order of the following lines:
        cloneData[gestureIndex].samples.unshift(newSample);
        gestureStore.currentModel.update(cloneData[gestureIndex].getCroppedData(), this.latestTimestamp);
        cloneData[gestureIndex].displayGesture = gestureStore.currentModel.prototype;

        this.gestures = cloneData;
        this.markDirty();
    }


    private receiveMessage(data: pxt.editor.ExtensionMessage) {
        const ev = data as pxt.editor.ExtensionEvent;
        if (ev.event) {
            switch (ev.event) {
                case "extconsole":
                    const cons = ev as pxt.editor.ConsoleEvent;
                    // drop sim
                    if (cons.body.sim) return;
                    this.onSerialData(cons.body.data);
                    break;
                case "extshown":
                    console.log('pxt-gestures shown')
                    this.connected = true;
                    this.sendRequest("extdatastream");
                    this.sendRequest("extreadcode")
                    break;
                case "exthidden":
                    console.log('pxt-gestures hidden')
                    this.connected = false;
                    break;
                default:
                    break;
            }
            return;
        }

        const action = this.idToType[data.id];
        console.log(`msg: ${action}`)
        delete this.idToType[data.id];
        switch (action) {
            case "extinit":
                this.sendRequest("extdatastream");
                this.sendRequest("extreadcode");
                break;
            case "extreadcode":
                // received existing code
                const usercode = data as pxt.editor.ReadCodeResponse;
                this.loadBlocks(usercode.resp.code, usercode.resp.json);
                break;
            default: break;
        }
    }


    private sendRequest(action: string, body?: any) {
        const id = Math.random().toString();
        this.idToType[id] = action;
        const msg = {
            type: "pxtpkgext",
            action: action,
            extId: this.extId,
            response: true,
            id: id,
            body
        };
        if (window.parent && window != window.parent)
            window.parent.postMessage(msg, "*");
    }


    /**
     * Initializes the serial port (using hid for the Circuit Playground) and sets the onSerialData event function
     * to update the realtime graph, feed the recorder, and feed the realtime DTW model (if it is running)
     */
    private onSerialData(strBuf: string) {
        const newData = parseString(strBuf);
        if (newData && newData.acc)
            serialData.notify(newData);

        this.connected = true;
    }



    /**
     * updates this.state.data[] array and the models[] array with a 
     * new Gesture and switches to the editGesture window
     */
    @action public addGesture() {
        this.gestures.push(new Gesture());
        // TODO: change this method of keeping the current gesture index to something more reliable
        this.curGestureIndex = this.gestures.length - 1;
        const model = new SingleDTWCore(this.gestures[this.curGestureIndex].gestureID + 1, this.gestures[this.curGestureIndex].name);
        this.models.push(model);
    }


    /**
     * will generate the code blocks for each running DTW model and will rewrite 
     * the contents of the custom.ts file with 
     */
    private saveBlocksNow() {
        if (!this.hasBeenModified) return;
        let cloneData = this.gestures.slice();

        const codeBlocks: string[] = this.models
            .filter(m => m.isRunning())
            .map(m => m.generateBlock());
        const code = SingleDTWCore.generateNamespace(codeBlocks);
        const json = JSON.stringify(this.gestures, null, 2);
        this.sendRequest("extwritecode", { code, json });
        this.hasBeenModified = false;

        this.gestures = cloneData; // FIXME: Why did Majeed do this?
    }


    markDirty() {
        if (!this.hasBeenModified) {
            this.hasBeenModified = true;
            this.saveBlocks();
        }
    }


    @action private loadBlocks(code: string, json: string) {
        if (!json) return;

        let jsonGestures: Gesture[] = JSON.parse(json);
        if (!jsonGestures) return;

        this.gestures = jsonGestures.map(importedGesture => 
            Gesture.parseGesture(importedGesture));

        this.models = this.gestures.map(gesture => {
            let model = new SingleDTWCore(gesture.gestureID + 1, gesture.name);
            model.update(gesture.getCroppedData(), this.latestTimestamp);
            return model;
        });
    }



    /**
     * Removes the currently active gesture if it contains no samples
     */
    @action public deleteIfGestureEmpty() {
        if (this.gestures.length > 0 && this.gestures[this.curGestureIndex].samples.length == 0) {
            // delete the gesture
            let cloneData = this.gestures.slice();
            cloneData.splice(this.curGestureIndex, 1);
            // delete the model
            this.models.splice(this.curGestureIndex, 1);
            this.gestures = cloneData;
        }
    }

    @action public deleteGesture(gesture: Gesture) {
        const index = this.gestures.indexOf(gesture);
        if (index >= 0) {
            this.gestures.splice(index, 1);
            this.models.splice(index, 1);
            this.markDirty();
        }
    }

}



// Returns a function, that, as long as it continues to be invoked, will not
// be triggered. The function will be called after it stops being called for
// N milliseconds. If `immediate` is passed, trigger the function on the
// leading edge, instead of the trailing.
function debounce(func: (...args: any[]) => any, wait: number, immediate?: boolean): any {
    let timeout: any;
    return function () {
        let context = this;
        let args = arguments;
        let later = function () {
            timeout = null;
            if (!immediate) func.apply(context, args);
        };
        let callNow = immediate && !timeout;
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
        if (callNow) func.apply(context, args);
    };
}


function parseString(strBuf: string): any {
    // populate members of newData (type: SensorData) with the values received from the device
    let strBufArray = strBuf.split(" ");
    let result = {
        acc: false, accVec: new MotionReading(0, 0, 0),
        /*mag: false, magVec: new Vector(0, 0, 0)*/
    };

    for (let i = 0; i < strBufArray.length; i++) {
        if (strBufArray[i] == "A") {
            result.accVec = new MotionReading(
                parseInt(strBufArray[i + 1]), 
                parseInt(strBufArray[i + 2]), 
                parseInt(strBufArray[i + 3]));
            result.acc = true;

            i += 3;
        }
    }

    return result;
}


export const gestureStore = new GestureStore();
