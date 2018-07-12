import * as Debug from "debug";
import {LoaderEvents, Segment as LoaderSegment, LoaderInterface} from "p2p-media-loader-core";
import {ParserSegment} from "./parser-segment";

const defaultSettings = {
    // The duration in seconds; used by manager to build up predicted forward segments sequence; used to predownload and share via P2P
    forwardSequenceDuration: 60,
    // Maximum amount of segments manager should hold from the load() calls; used to build up sequence with correct priorities for P2P sharing
    maxHistorySegments: 100,
    // Shaka player measures time spent on loading data when its request gets resolved;
    // Shaka player does assumtions about network speed and might decide to change playback quality (if its set to 'auto');
    // If simulateTimeDelation is true, we're trying to simulate this behaivior (meaning if some data was preloaded by us
    // and player asked for it, we do not resolve request immediatelly, we delay resolving for amount of time spent on loading that data);
    simulateTimeDelation: true
};

export default class {

    private readonly debug = Debug("p2pml:shaka:sm");
    private readonly loader: LoaderInterface;
    private readonly requests: Map<string, Request> = new Map();
    private manifestUri: string = "";
    private playheadTime: number = 0;
    private readonly segmentHistory: ParserSegment[] = [];
    private readonly settings: any = undefined;

    public constructor(loader: LoaderInterface, settings: any = {}) {
        this.settings = Object.assign(defaultSettings, settings);

        this.loader = loader;
        this.loader.on(LoaderEvents.SegmentLoaded, this.onSegmentLoaded);
        this.loader.on(LoaderEvents.SegmentError, this.onSegmentError);
        this.loader.on(LoaderEvents.SegmentAbort, this.onSegmentAbort);
    }

    public isSupported (): boolean {
        return this.loader.isSupported();
    }

    public setPlayheadTime (time: number) {
        this.playheadTime = time;

        if (this.segmentHistory.length > 0) {
            this.refreshLoad();
        }
    }

    public async load (parserSegment: ParserSegment, manifestUri: string, playheadTime: number): Promise<any> {
        this.manifestUri = manifestUri;
        this.playheadTime = playheadTime;

        this.pushSegmentHistory(parserSegment);

        const lastRequestedSegment = this.refreshLoad();
        const alreadyLoadedSegment = this.loader.getSegment(lastRequestedSegment.id);

        return new Promise<any>((resolve, reject) => {
            const request = new Request(lastRequestedSegment.id, resolve, reject);
            if (alreadyLoadedSegment) {
                this.reportSuccess(request, alreadyLoadedSegment);
            } else {
                this.debug("request add", request.id);
                this.requests.set(request.id, request);
            }
        });
    }

    private refreshLoad (): LoaderSegment {
        const lastRequestedSegment = this.segmentHistory[ this.segmentHistory.length - 1 ];
        const safePlayheadTime = this.playheadTime > 0.1 ? this.playheadTime : lastRequestedSegment.start;
        const sequence: ParserSegment[] = this.segmentHistory.reduce((a: ParserSegment[], i) => {
            if (i.start >= safePlayheadTime) {
                a.push(i);
            }
            return a;
        }, []);

        if (sequence.length === 0) {
            sequence.push(lastRequestedSegment);
        }

        const lastRequestedSegmentIndex = sequence.length - 1;
        let duration = sequence.reduce((a, i) => a + i.end - i.start, 0);

        do {
            const next = sequence[ sequence.length - 1 ].next();
            if (next) {
                sequence.push(next);
                duration += next.end - next.start;
            } else {
                break;
            }
        } while (duration < this.settings.forwardSequenceDuration);

        const manifestUriNoQuery = this.manifestUri.split("?")[ 0 ];

        const loaderSegments: LoaderSegment[] = sequence.map((s, i) => {
            return new LoaderSegment(
                `${manifestUriNoQuery}+${s.identity}`,
                s.uri,
                s.range,
                i
            );
        });

        this.loader.load(loaderSegments, `${manifestUriNoQuery}+${lastRequestedSegment.streamIdentity}`);
        return loaderSegments[ lastRequestedSegmentIndex ];
    }

    public destroy () {
        if (this.requests.size !== 0) {
            console.error("Destroying segment manager with active request(s)!");
            this.requests.clear();
        }

        this.playheadTime = 0;
        this.segmentHistory.splice(0);
        this.loader.destroy();
    }

    private pushSegmentHistory (segment: ParserSegment) {
        if (this.segmentHistory.length >= this.settings.maxHistorySegments) {
            this.debug("segment history auto shrink");
            this.segmentHistory.splice(0, this.settings.maxHistorySegments * 0.2);
        }

        if (this.segmentHistory.length > 0 && this.segmentHistory[ this.segmentHistory.length - 1 ].start > segment.start) {
            this.debug("segment history reset due to playhead seek back");
            this.segmentHistory.splice(0);
        }

        this.segmentHistory.push(segment);
    }

    private reportSuccess (request: Request, loaderSegment: LoaderSegment) {
        if (request.resolve) {
            let timeDelation = 0;
            if (this.settings.simulateTimeDelation && loaderSegment.downloadSpeed > 0 && loaderSegment.data && loaderSegment.data.byteLength > 0) {
                const downloadTime = Math.trunc(loaderSegment.data.byteLength / loaderSegment.downloadSpeed);
                timeDelation = Date.now() - request.timeCreated + downloadTime;
            }
            setTimeout(() => {
                this.debug("report success", request.id);
                request.resolve(loaderSegment.data);
            }, timeDelation);
        }
    }

    private reportError (request: Request, error: any) {
        if (request.reject) {
            this.debug("report error", request.id);
            request.reject(error);
        }
    }

    private onSegmentLoaded = (segment: LoaderSegment) => {
        if (this.requests.has(segment.id)) {
            this.reportSuccess(this.requests.get(segment.id)!, segment);
            this.debug("request delete", segment.id);
            this.requests.delete(segment.id);
        }
    }

    private onSegmentError = (segment: LoaderSegment, error: any) => {
        if (this.requests.has(segment.id)) {
            this.reportError(this.requests.get(segment.id)!, error);
            this.debug("request delete from error", segment.id);
            this.requests.delete(segment.id);
        }
    }

    private onSegmentAbort = (segment: LoaderSegment) => {
        if (this.requests.has(segment.id)) {
            this.reportError(this.requests.get(segment.id)!, "Internal abort");
            this.debug("request delete from abort", segment.id);
            this.requests.delete(segment.id);
        }
    }

} // end of default class

class Request {
    readonly timeCreated: number = Date.now();
    public constructor (
        readonly id: string,
        readonly resolve: any,
        readonly reject: any
    ) {}
}
