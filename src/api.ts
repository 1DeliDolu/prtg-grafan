import { DataSourcePluginOptionsEditorProps, DataSourceInstanceSettings } from '@grafana/data';
import { getBackendSrv } from '@grafana/runtime';
import { MySecureJsonData, MyDataSourceOptions, PrtgApiConfig, PRTGItem, PRTGItemChannel, PrtgStatusListResponse, } from './types';
import { lastValueFrom } from 'rxjs';

export class PrtgApi {
    config: PrtgApiConfig;
    
    constructor(instanceSettings: DataSourceInstanceSettings<MyDataSourceOptions> | DataSourcePluginOptionsEditorProps<MyDataSourceOptions, MySecureJsonData>) {
        this.config = {
            url: instanceSettings.url || '',
            apiToken: '',
        };
    }

    buildApiUrl(method: string, params: Record<string, string> = {}): string {
        const baseUrl = `${this.config.url}/api/${method}`;
        const url = new URL(baseUrl);

        // Add additional parameters
        for (const [key, value] of Object.entries(params)) {
            url.searchParams.set(key, value);
        }

        return url.toString();
    }

    async baseExecuteRequest(endpoint: string, params: Record<string, string> = {}): Promise<any> {
        try {
            const apiUrl = this.buildApiUrl(endpoint, params);
            
            const options = {
                method: 'GET',
                url: apiUrl,
                headers: { 
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
            };
            
            const response = await lastValueFrom(getBackendSrv().fetch(options));
            
            if (!response || response.status === 403) {
                throw new Error('Access denied: please verify API token and permissions');
            }
            
            if (response.status !== 200) {
                throw new Error(`Unexpected status code: ${response.status}`);
            }
            
            return response.data;
        } catch (error) {
            console.error('Request failed:', error);
            throw error;
        }
    }

    async getSensors(device: string): Promise<PRTGItem> {
        if (!device) {
            throw new Error('device parameter is required');
        }

        const params = {
            content: 'sensors',
            columns: 'active,channel,datetime,device,group,message,objid,priority,sensor,status,tags',
            count: '50000',
            filter_device: device,
        };

        const response = await this.baseExecuteRequest('table.json', params);
        return response.sensors || [];
    }

    async getDevices(group: string): Promise<PRTGItem[]> {
        if (!group) {
            throw new Error('group parameter is required');
        }

        const params = {
            content: 'devices',
            columns: 'active,channel,datetime,device,group,message,objid,priority,sensor,status,tags',
            count: '50000',
            filter_group: group,
        };

        const response = await this.baseExecuteRequest('table.json', params);
        return response.devices || [];
    }

    async getSensorHistory(sensorId: number, startDate: string, endDate: string): Promise<PRTGItemChannel> {
        if (!sensorId) {
            throw new Error('sensorId parameter is required');
        }
        
        // Calculate time range to determine appropriate avg value
        const start = new Date(startDate);
        const end = new Date(endDate);
        const hours = (end.getTime() - start.getTime()) / (1000 * 60 * 60);
        
        // Determine appropriate avg value based on time range
        let avg = '0'; // Default for small ranges (≤ 12 hours)
        if (hours > 720) {
            avg = '86400';      // > 30 days
        } else if (hours > 336) {
            avg = '3600';       // > 14 days
        } else if (hours > 168) {
            avg = '1800';       // > 7 days
        } else if (hours > 72) {
            avg = '900';        // > 3 days
        } else if (hours > 48) {
            avg = '600';        // > 2 days
        } else if (hours > 24) {
            avg = '300';        // > 1 day
        } else if (hours > 12) {
            avg = '120';        // > 12 hours
        }
        
        const params = {
            id: sensorId.toString(),
            avg: avg,
            sdate: startDate,
            edate: endDate,
            columns: 'datetime,value_',
            usecaption: '1',
            count: '50000'
        };

        const response = await this.baseExecuteRequest('historicdata.json', params);
        return response.channels || response.histdata || [];
    }
    
    async getChannels(objid: string): Promise<PRTGItemChannel> {
        const params = {
            content: 'values',
            id: objid,
            columns: 'value_,datetime',
            usecaption: 'true',
        };
        
        const response = await this.baseExecuteRequest('historicdata.json', params);
        return response.channels || [];
    }

    /**
     * Retrieves the status information from the PRTG server
     * @returns Status information including version, licensing, and server details
     */
    async getStatusList(): Promise<PrtgStatusListResponse> {
        const response = await this.baseExecuteRequest('status.json', {});
        return response;
    }


    async getGroupList(): Promise<PRTGItem[]> {
        const params = {
            content: 'groups',
            columns: 'active,channel,datetime,device,group,message,objid,priority,sensor,status,tags',
            count: '50000',
            output: 'json'
        };
        
        const response = await this.baseExecuteRequest('table.json', params);
        return response.groups || [];
    }

    /**
     * Retrieves data for annotations based on the provided query parameters
     * @param query The annotation query parameters
     * @returns Formatted annotation data for display in Grafana
     */
    async getAnnotationData(query: {
        sensorId: string;
        from: number;
        to: number;
        limit?: number;
    }): Promise<any> {
        // Convert timestamps to date strings
        const fromTime = new Date(query.from);
        const toTime = new Date(query.to);
        
        // Format dates for PRTG API
        const fromStr = fromTime.toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const toStr = toTime.toISOString().replace(/[:.]/g, '-').slice(0, 19);
        
        // Get historical data
        const histData = await this.getSensorHistory(Number(query.sensorId), fromStr, toStr);
        
        // Transform to Grafana annotation format
        const annotations = (histData || []).map((data, i) => {
            const time = new Date(data.datetime).getTime();
            
            return {
                id: `uid:${query.sensorId}_${i}`,
                time: time,
                timeEnd: time,
                title: `Sensor: ${query.sensorId}`,
                tags: ['prtg', `sensor:${query.sensorId}`],
                type: 'annotation',
                data: data.value_,
            };
        });
        
        // Apply limit if specified
        const limitedAnnotations = query.limit && query.limit > 0 
            ? annotations.slice(0, query.limit)
            : annotations;
        
        return {
            annotations: limitedAnnotations,
            total: limitedAnnotations.length,
        };
    }
}
