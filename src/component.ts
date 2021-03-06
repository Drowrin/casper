import { Entity, EntityData, EntityMap, Manifest } from './schema';

export namespace Component {
    export interface Context {
        /**
         * The initial entities parsed from the source yaml.
         * This is a map of string ids to EntityData objects.
         */
        entities: EntityMap;

        /**
         * The full map of in-progress entities in their current state.
         * A component can read already processed data here from components that have already run.
         */
        manifest: Manifest;

        /**
         * A map of string KEYs to string ID arrays.
         * The id of every entity that passes a component's trigger so far is put in the ID array under that component's KEY.
         */
        passed: { [key: string]: string[] };

        /**
         * The current entity being processed.
         * This is partial/in-progress data, not the source data.
         * This is the state of the entity directly before this component is added to it.
         * As such the state should not be relied on, but it can still be used to get entity name, id, and so on.
         */
        parent: Entity;

        /**
         * A shortcut to the id of the current entity being processed.
         */
        id: string;

        /**
         * The entity data parsed from the source without any processing.
         */
        data: EntityData;

        /**
         * A list of all components, in order of when they are processed.
         */
        components: Component[];
    }

    /**
     * A collection of all registered components.
     */
    var list: Component[] = [];

    /**
     * Register a component so it can be accessed globally.
     * As a side effect, this helps validate namespaces that are intended to become Components.
     * @param {Component} c The component to be registered
     */
    export function register(c: Component) {
        if (!list.includes(c)) {
            list.push(c);
        }
    }

    export function dependencies(c: Component) {
        let wait_for = c.WAIT_FOR || [];
        let requires = c.REQUIRES || [];
        let hoists = c.HOIST
            ? // If this component is marked to HOIST, do not require other HOIST components
              []
            : // If this component is not marked to HOIST, WAIT_FOR all HOIST components
              list.filter((c) => c.HOIST).map((c) => c.KEY);
        let sinks = c.SINK
            ? // If this component is marked to SINK, WAIT_FOR all non-SINK components
              list.filter((c) => !c.SINK).map((c) => c.KEY)
            : // If this component is not marked to SINK, do nothing
              [];

        return Array.from(
            new Set([...wait_for, ...requires, ...hoists, ...sinks])
        );
    }

    /**
     * Get the list of all registered components.
     * Topographically sorted based on WAIT_FOR.
     */
    export function all(): Component[] {
        let _list = list.map((c) => {
            return {
                node: c,
                dep: dependencies(c),
            };
        });

        let out = [];
        let no_edges = _list.filter((c) => c.dep.length == 0);

        while (no_edges.length > 0) {
            let n = <any>no_edges.pop();

            out.push(n);

            for (var m of _list) {
                let i = m.dep.indexOf(n.node.KEY);

                if (i !== undefined && i >= 0) {
                    m.dep.splice(i, 1);

                    if (m.dep.length == 0) {
                        no_edges.push(m);
                    }
                }
            }
        }

        return out.map((c) => c.node);
    }

    /**
     * Adds constructed Component to Entity if the Component's key is present in the EntityData.
     * This function does not return anything, it modifies the parent Entity in-place.
     * @param {Component} c The component to be resolved
     * @param {Component.Context} ctx The context of resolving this entity
     */
    export function resolve(c: Component, ctx: Context) {
        // if the component doesn't have a trigger function, default to checking for KEY
        let trigger = c.trigger || ((_ctx) => c.KEY in _ctx.data);

        // if the component doesn't have a getData function, default to EntityData[KEY]
        let getData = c.getData || ((_ctx) => (<any>_ctx.data)[c.KEY]);

        // if the component doesn't have a process function, default to a passthrough
        let process = c.process || ((data, _) => data);

        // if the component doesn't have a transform function, default to placing at parent[KEY]
        let transform = c.transform || ((o, _ctx) => (_ctx.parent[c.KEY] = o));

        // only operate if the trigger passes
        if (trigger(ctx)) {
            // Mark that this entity passed the trigger
            ctx.passed[c.KEY].push(ctx.id);

            // check that the parent entity contains all of the other components required by this component
            c.REQUIRES?.forEach((r) => {
                if (!ctx.passed[r].includes(ctx.id))
                    throw `${ctx.id} does not contain "${r}", which is a requirement for "${c.KEY}"`;
            });

            // get component-specific data from the entity data
            const cData = getData(ctx);

            let out = process(cData, ctx);

            // only assign data to parent if the output is defined
            if (out !== undefined) transform(out, ctx);
        }
    }
}

export interface Component {
    /**
     * The key on the root of an entity that will be interpreted as this component.
     * Also, the output data is stored at entity.KEY.
     * */
    KEY: string;

    /**
     * Array of keys referring to other components that this component requires.
     * If a required component is not present on an entity, this component's valirdator will fail.
     * Note: This should not be two-way.
     * Components should have a hierarchy and should not create a dependency cycle.
     */
    REQUIRES?: string[];

    /**
     * Similar to REQUIRES. This marks components that will often accompany this component, but are not required.
     * This is used to gather hierarchy information for type analysis.
     */
    OPTIONAL?: string[];

    /**
     * Mark if this component should not be considered for type analysis.
     * For example, a wide-sweeping component like `Categories`, or very basic components like `Description`.
     */
    SUPPRESS_TYPE?: boolean;

    /**
     * Hoist to the top of the Topographical sort. The sort will try to keep this element early in the order.
     * Internally, makes all non-HOIST components WAIT_FOR this one.
     */
    HOIST?: boolean;

    /**
     * Sink to the bottom of the Topographical sort. The sort will try to keep this element late in the order.
     * Internally, makes this component WAIT_FOR all non-SINK components.
     */
    SINK?: boolean;

    /**
     * Array of keys referring to other components that must be processed before this one.
     * REQUIRES is automatically included in this list. WAIT_FOR should include things not present in REQUIRES.
     * Different from REQUIRES, in that these components do not need to be present on the entity being processed.
     * For example, a component may need to wait for other entities' descriptions to be rendered.
     */
    WAIT_FOR?: string[];

    /**
     * A function to determine if this component's processing should trigger.
     * If this function is not included, the default trigger checks if KEY is in the data.
     * @param {Component.Context} ctx The context of this processing call. See Component.Context for more info
     * @returns {boolean} Will be true only if the component's processing should run
     */
    trigger?(ctx: Component.Context): boolean;

    /**
     * A function that gets the component data from the entity data after the trigger passes.
     * If this function is not included, the default behavior is to read EntityData[KEY].
     * @param {Component.Context} ctx The context of this processing call. See Component.Context for more info
     * @returns {any} The data to be passed to the process function
     */
    getData?(ctx: Component.Context): any;

    /**
     * A function that is called to process input data before it is entered into the final manifest.
     * This function is optional. If not present, the data will be copied from source as-is.
     * If the function does not return or returns `undefined`, the transform function will not be triggered.
     *
     * @param {any} data The data for this component, parsed directly from the source yaml
     * @param {Component.Context} ctx The context of this processing call. See Component.Context for more info
     * @returns {any} The processed data that will be output into the final manifest
     */
    process?(data: any, ctx: Component.Context): any;

    /**
     * A function that transforms the parent entity using the processed data.
     * If this function is not included, the default behavior is to enter data at parent[KEY].
     * @param {any} processed The processed data
     * @param {Component.Context} ctx The context of this processing call. See Component.Context for more info
     */
    transform?(processed: any, ctx: Component.Context): void;
}
